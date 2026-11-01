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

internal object ActivityWebViewRegistry {

    var registrySerial by mutableIntStateOf(0)
        private set
    var reloads by mutableIntStateOf(0)
        private set

    var pendingExternalUrl by mutableStateOf<String?>(null)
        private set

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
        var mount = 0
    }

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
            val mount = session.bridgeGeneration
            main.post {
                if (entries[id] == null && session.bridgeGeneration == mount) {
                    session.embedFailed(appSessionId = id, issue = AppHostIssue.loadFailed, mount = mount)
                }
            }
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
            if (current == null || current.webView !== webView || current.mount == 0) return@addWebMessageListener
            current.replyProxy = replyProxy
            current.session.receiveFromEmbed(raw = message.data ?: "", origin = sourceOrigin.toString(), isMainFrame = isMainFrame, mount = current.mount)
        }
        val url = AppBridgeProtocol.androidEntryURL(appId = model.appId, callSessionId = session.callSessionId, appSessionId = id)

        main.post {
            val current = entries[id]
            if (current == null || current !== entry) return@post
            val attached = session.attachBridge(appSessionId = id) { json ->
                if (entries[id] === entry) entry.replyProxy?.postMessage(json)
            }
            if (!attached) return@post
            entry.mount = session.bridgeGeneration
            webView.loadUrl(url)
            registrySerial += 1
        }
        return webView
    }

    fun release(id: String) {
        val entry = entries.remove(id) ?: return
        if (entry.mount != 0) entry.session.detachBridge(appSessionId = id, mount = entry.mount)
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
                val current = entries[id]
                if (current == null || current.webView !== view || current.mount == 0) return
                if (request.isForMainFrame && !session.embedReady) {
                    session.embedFailed(appSessionId = id, issue = AppHostIssue.loadFailed, mount = current.mount)
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                val current = entries[id]
                if (current == null || current.webView !== view || current.mount == 0) return true

                session.embedFailed(appSessionId = id, issue = AppHostIssue.rendererGone, mount = current.mount)
                main.post { if (entries[id] === current) release(id) }
                return true
            }
        }
        return webView
    }

    private fun blocked(): WebResourceResponse =
        WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
}
