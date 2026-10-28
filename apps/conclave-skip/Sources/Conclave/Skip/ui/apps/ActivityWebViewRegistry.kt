package conclave.module

import android.annotation.SuppressLint
import android.content.Context
import android.content.MutableContextWrapper
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebResourceErrorCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream

/*
 * S60 L6-15 and 13 d (ACT-7) on Android: the platform registry of web engines for activity bodies (never transpiled).
 * Keyed by appSessionId, it creates the one WebView on the first host appearance for that id and releases it when the
 * shared session publishes ended (ActiveAppSession.onBridgeEnded), a renderer dies or Try Again replaces it, never on
 * recomposition, so Show video, panels, rotation and PiP keep the same instance (app.registrySerial and app.reloads,
 * L6-12). The view lives in a MutableContextWrapper whose base context follows the current activity.
 *
 * Isolation (D14, C6-19, C6-25): JavaScript and DOM storage on, file and content access off; WebViewAssetLoader serves the
 * bundled, versioned embed from https://appassets.androidplatform.net/assets/native-embed/ and every other request gets
 * an empty 403 (the page CSP also sets connect-src 'none'); messaging only through
 * WebViewCompat.addWebMessageListener(webView, "conclaveApp", setOf(bundleOrigin), listener) (origin-checked by the
 * engine, and again by ActiveAppSession), never addJavascriptInterface. addWebMessageListener depends on the installed
 * WebView, so WebViewFeature.WEB_MESSAGE_LISTENER is checked at run time and its absence shows the failure state.
 * shouldOverrideUrlLoading blocks other origins (a user link asks first, then Custom Tabs with PiP auto-enter suppressed);
 * onRenderProcessGone returns true and moves the card to the failure state, so the call survives.
 *
 * ACT-8: Watch Together's page frames the privacy-enhanced YouTube player and nothing else (AppEmbedFramePolicy, shared
 * with the iOS registry and the page CSP frame-src). Only for that app, subresource requests that are not the main
 * frame may reach the network (the page itself has connect-src 'none' and hash-only scripts, so they come from the
 * YouTube frame) and a subframe may navigate to the YouTube embed path; every other app keeps the empty 403 for anything
 * outside the bundle. Watch and the Wheel may start media without a tap inside the page (the room's playback follows;
 * the spin sounds follow the native Spin tap), AppEmbedFramePolicy.playsMediaWithoutTap; the player's own play button
 * stays the prompt when the engine still blocks it.
 */
internal object ActivityWebViewRegistry {
    /** Web views created (app.registrySerial) and recreations for Try Again (app.reloads). */
    var registrySerial by mutableIntStateOf(0)
        private set
    var reloads by mutableIntStateOf(0)
        private set
    /** A user-initiated link from the embed waiting for "Open this link?". */
    var pendingExternalUrl by mutableStateOf<String?>(null)
        private set

    /** A test seam (Robolectric has no WebView provider): whether the installed engine has the message listener. */
    internal var supportsMessageListener: () -> Boolean = { WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) }

    private val entries = HashMap<String, Entry>()
    private val main = Handler(Looper.getMainLooper())

    private class Entry(
        val webView: WebView,
        val wrapper: MutableContextWrapper,
        val reloadSerial: Int,
        val session: ActiveAppSession,
    ) {
        var replyProxy: JavaScriptReplyProxy? = null
    }

    /**
     * The registered WebView for the host's app session, created on first use; null when the host must not hold one
     * (failure states, no embed for the app), the engine lacks the message listener or the bundle is missing (the session
     * then reports a load failure).
     */
    fun webView(context: Context, model: AppHostModel, session: ActiveAppSession, backgroundArgb: Int): WebView? {
        val id = model.appSessionId
        if (!model.wantsWebView || id.isEmpty() || id != session.appSessionId) return null
        val existing = entries[id]
        if (existing != null) {
            if (existing.reloadSerial == model.reloadSerial) {
                existing.wrapper.setBaseContext(context)
                return existing.webView
            }
            release(id)
            main.post { reloads += 1 }
        }
        for (staleId in entries.keys.toList()) {
            if (staleId != id) release(staleId)
        }
        val assetPath = AppBridgeProtocol.androidAssetPath(appId = model.appId)
        if (!supportsMessageListener() || assetPath.isEmpty() || !assetExists(context, assetPath)) {
            main.post { session.embedFailed(appSessionId = id, issue = AppHostIssue.loadFailed) }
            return null
        }
        val wrapper = MutableContextWrapper(context)
        val webView = makeWebView(wrapper, id, model.appId, session, backgroundArgb)
        val entry = Entry(webView, wrapper, model.reloadSerial, session)
        entries[id] = entry
        session.bundleOrigin = AppBridgeProtocol.androidOrigin
        session.onBridgeEnded = { endedId -> release(endedId) }
        WebViewCompat.addWebMessageListener(
            webView,
            AppBridgeProtocol.handlerName,
            setOf(AppBridgeProtocol.androidOrigin),
        ) { _, message, sourceOrigin, isMainFrame, replyProxy ->
            val current = entries[id]
            if (current == null || current.webView !== webView) return@addWebMessageListener
            current.replyProxy = replyProxy
            current.session.receiveFromEmbed(raw = message.data ?: "", origin = sourceOrigin.toString(), isMainFrame = isMainFrame)
        }
        val url = AppBridgeProtocol.androidEntryURL(appId = model.appId, callSessionId = session.callSessionId, appSessionId = id)
        // Attaching emits the session's loadStarted (the presenter publishes), so it runs after this composition pass.
        main.post {
            val current = entries[id]
            if (current == null || current !== entry) return@post
            session.attachBridge(appSessionId = id) { json -> entries[id]?.replyProxy?.postMessage(json) }
            webView.loadUrl(url)
            registrySerial += 1
        }
        return webView
    }

    /** Detaches the bridge and destroys the WebView. */
    fun release(id: String) {
        val entry = entries.remove(id) ?: return
        entry.session.detachBridge(appSessionId = id)
        runCatching { WebViewCompat.removeWebMessageListener(entry.webView, AppBridgeProtocol.handlerName) }
        (entry.webView.parent as? ViewGroup)?.removeView(entry.webView)
        entry.webView.stopLoading()
        entry.webView.destroy()
        entry.wrapper.setBaseContext(entry.wrapper.applicationContext)
    }

    fun hasWebView(id: String): Boolean = entries.containsKey(id)

    fun clearExternalLink() {
        if (pendingExternalUrl != null) pendingExternalUrl = null
    }

    internal fun requestExternalLink(url: String) {
        pendingExternalUrl = url
    }

    private fun assetExists(context: Context, path: String): Boolean =
        runCatching { context.assets.open(path).use { true } }.getOrDefault(false)

    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWebView(context: Context, id: String, appId: String, session: ActiveAppSession, backgroundArgb: Int): WebView {
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()
        val webView = WebView(context)
        webView.setBackgroundColor(backgroundArgb)
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        webView.overScrollMode = android.view.View.OVER_SCROLL_NEVER
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = !AppEmbedFramePolicy.playsMediaWithoutTap(appId = appId)
            cacheMode = WebSettings.LOAD_NO_CACHE
            setGeolocationEnabled(false)
        }
        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url
                if (url.scheme == "https" && url.host == WebViewAssetLoader.DEFAULT_DOMAIN) {
                    return loader.shouldInterceptRequest(url) ?: blocked()
                }
                // ACT-8: the YouTube frame's own requests (Watch Together only); null lets the engine load them.
                if (AppEmbedFramePolicy.allowsNetworkSubresource(appId = appId, url = url.toString(), isMainFrame = request.isForMainFrame)) {
                    return null
                }
                return blocked()
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val target = request.url.toString()
                if (request.isForMainFrame && AppBridgeProtocol.isBundleURL(target, origin = AppBridgeProtocol.androidOrigin)) {
                    return false
                }
                if (!request.isForMainFrame && AppEmbedFramePolicy.allowsSubframe(appId = appId, url = target)) {
                    return false
                }
                if (request.hasGesture() && AppBridgeProtocol.isOpenableExternalLink(target)) {
                    requestExternalLink(target)
                }
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceErrorCompat) {
                if (request.isForMainFrame && !session.embedReady) {
                    session.embedFailed(appSessionId = id, issue = AppHostIssue.loadFailed)
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The view is unusable after this: release it, show the failure state, keep the call running.
                session.embedFailed(appSessionId = id, issue = AppHostIssue.rendererGone)
                main.post { release(id) }
                return true
            }
        }
        return webView
    }

    private fun blocked(): WebResourceResponse =
        WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
}
