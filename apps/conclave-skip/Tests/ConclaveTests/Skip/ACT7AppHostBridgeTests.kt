package conclave.module

import android.os.Looper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.json.JSONObject

/**
 * ACT-7 through the transpiled bridge codec, relay and presenter plus the handwritten host helpers (the Swift half is
 * T/ACT7AppHostTests.swift, and both mirror packages/apps-sdk/src/native-embed/contract-fixtures.json): hostile messages
 * rejected by reason through the Android JSON path, the presenter's phases, tags and pending-until-ack, the Android
 * origin, the C6-25 run-time WEB_MESSAGE_LISTENER fallback to the failure state, and every copy name the host asks for.
 * No composition and no WebView (Robolectric has no WebView provider).
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class ACT7AppHostBridgeTests {
    private val call = "call-7-3f2a9c1e"
    private val app = "app-5b1d7a2e-0c44-4e7b-9f3e-2a8d6c1b9e70"
    private val expectation = AppBridgeExpectation(origin = AppBridgeProtocol.iosOrigin, callSessionId = call, appSessionId = app)

    private fun envelope(type: String, payload: JSONObject?, requestId: String = "e-1", v: Int = 1,
                         callSessionId: String = call, appSessionId: String = app): String {
        val json = JSONObject()
        json.put("v", v)
        json.put("type", type)
        json.put("callSessionId", callSessionId)
        json.put("appSessionId", appSessionId)
        json.put("requestId", requestId)
        if (payload != null) json.put("payload", payload)
        return json.toString()
    }

    private fun decode(raw: String, origin: String = AppBridgeProtocol.iosOrigin, mainFrame: Boolean = true): String =
        AppBridgeCodec.decode(raw = raw, origin = origin, isMainFrame = mainFrame, expectation = expectation).rejection.rawValue

    @Test fun codecRejectsHostileMessagesLikeTheSharedFixtures() {
        val update = JSONObject().put("update", "AQID")
        assertEquals("none", decode(envelope("ready", JSONObject().put("bundleVersion", "1.0.0").put("appId", "whiteboard").put("stateVector", "AA=="))))
        assertEquals("none", decode(envelope("update", update)))
        assertEquals("none", decode(envelope("update", update), origin = AppBridgeProtocol.iosOrigin + "/"))
        assertEquals("wrongOrigin", decode(envelope("update", update), origin = "https://evil.example"))
        assertEquals("wrongOrigin", decode(envelope("update", update), origin = AppBridgeProtocol.androidOrigin))
        assertEquals("notMainFrame", decode(envelope("update", update), mainFrame = false))
        assertEquals("malformed", decode("{\"v\":1,\"type\":"))
        assertEquals("unknownType", decode(envelope("evaluate", JSONObject().put("code", "fetch('/')"))))
        assertEquals("versionMismatch", decode(envelope("update", update, v = 2)))
        assertEquals("none", decode(envelope("ready", JSONObject().put("bundleVersion", "2.0.0").put("appId", "whiteboard"), v = 2)))
        assertEquals("wrongCallSession", decode(envelope("update", update, callSessionId = "call-6-3f2a9c1e")))
        assertEquals("staleAppSession", decode(envelope("update", update, appSessionId = "app-old")))
        assertEquals("badRequestId", decode(envelope("update", update, requestId = "e 1")))
        assertEquals("badPayload", decode(envelope("update", JSONObject().put("update", "!!!!"))))
        assertEquals("badPayload", decode(envelope("status", JSONObject().put("tool", "script"))))
        assertEquals("badPayload", decode(envelope("status", JSONObject().put("color", "url(javascript:alert(1))"))))
        assertEquals("oversized", decode("x".repeat(AppBridgeProtocol.envelopeCharacterLimit + 1)))
    }

    @Test fun androidUrlsAndOriginsAreTheBundleOnly() {
        assertEquals("https://appassets.androidplatform.net/assets/native-embed/whiteboard.html#v=1&callSessionId=c&appSessionId=a&appId=whiteboard",
            AppBridgeProtocol.androidEntryURL(appId = "whiteboard", callSessionId = "c", appSessionId = "a"))
        assertEquals("", AppBridgeProtocol.androidEntryURL(appId = "wheel", callSessionId = "c", appSessionId = "a"))
        assertEquals("native-embed/whiteboard.html", AppBridgeProtocol.androidAssetPath(appId = "whiteboard"))
        assertTrue(AppBridgeProtocol.isBundleURL("https://appassets.androidplatform.net/assets/native-embed/whiteboard.html", origin = AppBridgeProtocol.androidOrigin))
        assertFalse(AppBridgeProtocol.isBundleURL("https://appassets.androidplatform.net.evil.example/x", origin = AppBridgeProtocol.androidOrigin))
        assertTrue(AppBridgeProtocol.isOpenableExternalLink("https://example.com"))
        assertFalse(AppBridgeProtocol.isOpenableExternalLink("intent://scan#Intent;end"))
    }

    @Test fun relayCountsRejectionsWithoutContentAndDropsReplays() {
        val relay = ActiveAppSession()
        val delivered = mutableListOf<String>()
        relay.bundleOrigin = AppBridgeProtocol.androidOrigin
        relay.begin(appId = "whiteboard", callSessionId = call, isReadOnly = false)
        assertTrue(relay.attachBridge(appSessionId = relay.appSessionId) { json -> delivered.add(json) })
        val id = relay.appSessionId
        val ready = JSONObject().put("v", 1).put("type", "ready").put("callSessionId", call).put("appSessionId", id).put("requestId", "e-1")
            .put("payload", JSONObject().put("bundleVersion", "1.0.0").put("appId", "whiteboard").put("stateVector", "AA==")).toString()
        assertEquals(AppBridgeRejection.wrongOrigin, relay.receiveFromEmbed(raw = ready, origin = AppBridgeProtocol.iosOrigin, isMainFrame = true))
        assertEquals(AppBridgeRejection.none, relay.receiveFromEmbed(raw = ready, origin = AppBridgeProtocol.androidOrigin, isMainFrame = true))
        assertTrue(relay.embedReady)
        assertEquals("status", JSONObject(delivered.first()).getString("type"))
        assertEquals(AppBridgeRejection.duplicateRequest, relay.receiveFromEmbed(raw = ready, origin = AppBridgeProtocol.androidOrigin, isMainFrame = true))
        val stale = JSONObject(ready).put("appSessionId", "app-old").put("requestId", "e-2").toString()
        assertEquals(AppBridgeRejection.staleAppSession, relay.receiveFromEmbed(raw = stale, origin = AppBridgeProtocol.androidOrigin, isMainFrame = true))
        assertEquals(3, relay.rejectionCount)
        for (entry in relay.rejections) assertNotNull(AppBridgeRejection.init(rawValue = entry))
        val ended = mutableListOf<String>()
        relay.onBridgeEnded = { endedId -> ended.add(endedId) }
        relay.end()
        assertEquals("close", JSONObject(delivered.last()).getString("type"))
        assertEquals(listOf(id), ended)
        assertEquals(AppBridgeRejection.notAttached, relay.receiveFromEmbed(raw = ready, origin = AppBridgeProtocol.androidOrigin, isMainFrame = true))
    }

    @Test fun presenterPhasesTagsAndPendingMatchSwift() {
        assertEquals(AppHostPhase.opening, AppHostPresenter.phase(hasApp = true, hasEmbed = true, issue = AppHostIssue.none, embedReady = false, closePending = false, canEdit = true))
        assertEquals(AppHostPhase.readOnly, AppHostPresenter.phase(hasApp = true, hasEmbed = true, issue = AppHostIssue.none, embedReady = true, closePending = false, canEdit = false))
        assertEquals(AppHostPhase.versionMismatch, AppHostPresenter.phase(hasApp = true, hasEmbed = false, issue = AppHostIssue.none, embedReady = false, closePending = false, canEdit = true))
        assertEquals(AppHostPhase.failed, AppHostPresenter.phase(hasApp = true, hasEmbed = true, issue = AppHostIssue.rendererGone, embedReady = true, closePending = false, canEdit = true))
        assertEquals(AppHostTag.viewOnly, AppHostPresenter.tag(isReconnecting = false, isLocked = true, isHost = false))
        assertEquals(AppHostTag.reconnecting, AppHostPresenter.tag(isReconnecting = true, isLocked = true, isHost = true))
        assertFalse(AppHostPresenter.isEditCommand(AppHostCommandKind.zoomToFit))
        assertTrue(AppHostPresenter.isEditCommand(AppHostCommandKind.setTool))
        assertNull(AppHostPresenter.payload(AppHostCommandKind.setColor, value = "#123456", extra = ""))
        assertNull(AppHostPresenter.payload(AppHostCommandKind.setTool, value = "script", extra = ""))

        val presenter = AppHostPresenter()
        val relay = ActiveAppSession()
        val delivered = mutableListOf<String>()
        relay.bundleOrigin = AppBridgeProtocol.androidOrigin
        presenter.bind(session = relay)
        relay.begin(appId = "whiteboard", callSessionId = call, isReadOnly = false)
        presenter.apply(AppHostInputs.make(callSession = 1, appId = "whiteboard", isHost = true))
        relay.attachBridge(appSessionId = relay.appSessionId) { json -> delivered.add(json) }
        assertEquals(AppHostPhase.opening, presenter.model.phase)
        assertTrue(presenter.model.wantsWebView)
        assertEquals(ActivityTapResult.explained, presenter.perform(AppHostCommandKind.setTool, value = "eraser"))
        val ready = JSONObject().put("v", 1).put("type", "ready").put("callSessionId", call).put("appSessionId", relay.appSessionId)
            .put("requestId", "e-1").put("payload", JSONObject().put("bundleVersion", "1.0.0").put("appId", "whiteboard")).toString()
        relay.receiveFromEmbed(raw = ready, origin = AppBridgeProtocol.androidOrigin, isMainFrame = true)
        assertEquals(AppHostPhase.ready, presenter.model.phase)
        assertEquals(ActivityTapResult.dispatched, presenter.perform(AppHostCommandKind.setTool, value = "eraser"))
        assertTrue(presenter.toolbar.isPending(AppHostCommandKind.setTool))
        assertEquals(ActivityTapResult.ignored, presenter.perform(AppHostCommandKind.setTool, value = "laser"))
        val sent = JSONObject(delivered.last())
        assertEquals("setTool", sent.getString("type"))
        val ack = JSONObject().put("v", 1).put("type", "ack").put("callSessionId", call).put("appSessionId", relay.appSessionId)
            .put("requestId", sent.getString("requestId")).put("payload", JSONObject().put("ok", true)).toString()
        relay.receiveFromEmbed(raw = ack, origin = AppBridgeProtocol.androidOrigin, isMainFrame = true)
        assertFalse(presenter.toolbar.isPending(AppHostCommandKind.setTool))
        assertEquals(ActivityTapResult.dispatched, presenter.confirmClose())
        assertEquals(ActivityTapResult.ignored, presenter.confirmClose())
        presenter.closeFailed()
        assertEquals(FeedbackKind.hostActionFailed, presenter.feedbackState.token.kind)
    }

    @Test fun missingWebMessageListenerShowsTheFailureState() {
        val presenter = AppHostPresenter()
        val relay = ActiveAppSession()
        presenter.bind(session = relay)
        relay.begin(appId = "whiteboard", callSessionId = call, isReadOnly = false)
        presenter.apply(AppHostInputs.make(callSession = 1, appId = "whiteboard", isHost = true))
        val previous = ActivityWebViewRegistry.supportsMessageListener
        ActivityWebViewRegistry.supportsMessageListener = { false }
        try {
            val view = ActivityWebViewRegistry.webView(RuntimeEnvironment.getApplication(), presenter.model, relay, 0)
            assertNull(view)
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(AppHostPhase.failed, presenter.model.phase)
            assertEquals(AppHostIssue.loadFailed, presenter.model.issue)
            assertFalse(presenter.model.wantsWebView)
            assertFalse(ActivityWebViewRegistry.hasWebView(relay.appSessionId))
        } finally {
            ActivityWebViewRegistry.supportsMessageListener = previous
        }
    }

    @Test fun everyHostCopyNameUsesAKnownPrefix() {
        val allowed = listOf("app_", "act_", "stg_", "ds_")
        val names = appHostStringResources + appHostPluralResources
        for (tool in AppWhiteboardTool.entries) assertTrue(names.contains(appHostToolResource(tool)))
        for (color in AppInkColor.entries) assertTrue(names.contains(appHostColorResource(color)))
        for (kind in AppHostCommandKind.entries) assertTrue(names.contains(appHostCommandResource(kind)))
        for (fill in AppShapeFill.entries) assertTrue(names.contains(appHostFillResource(fill)))
        for (tag in AppHostTag.entries) {
            val name = appHostTagResource(tag)
            if (tag == AppHostTag.none) assertNull(name) else assertTrue(allowed.any { name!!.startsWith(it) })
        }
        for (name in names) assertTrue(name, allowed.any { name.startsWith(it) })
        assertEquals(names.size, names.toSet().size)
        assertNotNull(inkSwatchColor("#a8a5ff"))
        assertNull(inkSwatchColor("red"))
        assertEquals(AppInkColor.entries.size, 20)
    }
}
