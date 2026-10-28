package conclave.module

import android.annotation.SuppressLint
import android.content.Context
import android.content.MutableContextWrapper
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/*
 * S60 L6-15 and 14 d (ACT-9) on Android: the shared browser's web engine registry (never transpiled). Keyed by
 * browserSessionId, it creates the one WebView on the first host appearance for that id and releases it when the
 * session ends (BrowserStagePresenter.onSessionEnded), when the card fails (the body's wantsWebView turns false), on Try
 * again (a new reload serial), on a role change and with releaseAll(), never on recomposition, so Show video, panels,
 * rotation and PiP keep the same instance. The view lives in a MutableContextWrapper whose base context follows the
 * current activity.
 *
 * The load-state contract (S60 14 d): onPageStarted and onPageFinished, main-frame onReceivedError and
 * onReceivedHttpError, onReceivedSslError shown as the failure state (the handshake is cancelled, never proceeded, and
 * never silently), and onRenderProcessGone returning true (failure state, the dead view released, the call survives).
 * Each report carries the session id and reload serial the WebView was created for, so a late callback from a replaced
 * view changes nothing. Isolation: JavaScript and DOM storage on (noVNC needs them), file and content access off, no
 * pop-up windows, http, https and about only. The input layer is transparent (setBackgroundColor(TRANSPARENT)) and the
 * one bundled CSS script hides the noVNC canvas; the Keyboard toggle runs the one bundled focus script. Viewers' touches
 * never reach the page. Nothing here logs a URL (noVNC and Live View URLs can be signed).
 */
internal object BrowserWebViewRegistry {
    /** L6-12 browser.inputViews: WebViews that take touches and keys (the controller's); viewers hold none. */
    var inputViews by mutableIntStateOf(0)
        private set
    /** WebViews created (fixtures read it to prove one instance survives layout changes). */
    var registrySerial by mutableIntStateOf(0)
        private set
    /** The current page's load progress (0 to 100) and the session it belongs to; read only by the progress leaf. */
    var pageProgress by mutableIntStateOf(0)
        private set
    var pageProgressSessionId by mutableStateOf("")
        private set

    private const val FIXTURE_TARGET = "conclave-fixture:browser"

    private val entries = HashMap<String, Entry>()
    private val main = Handler(Looper.getMainLooper())

    private class Entry(
        val webView: WebView,
        val wrapper: MutableContextWrapper,
        val browserSessionId: String,
        val reloadSerial: Int,
        val role: BrowserWebViewRole,
        var keyboardSerial: Int,
        var interactive: Boolean,
    ) {
        var loadedTarget = ""
    }

    /** The registered WebView for the card's browser session, created on first use; null when the card must not hold one. */
    fun webView(context: Context, model: BrowserStageModel, presenter: BrowserStagePresenter, stageArgb: Int): WebView? {
        val id = model.browserSessionId
        if (!model.wantsWebView || id.isEmpty()) return null
        val existing = entries[id]
        if (existing != null) {
            if (existing.reloadSerial == model.reloadSerial && existing.role == model.webViewRole) {
                existing.wrapper.setBaseContext(context)
                sync(existing, model, presenter)
                return existing.webView
            }
            release(id)
        }
        for (staleId in entries.keys.toList()) {
            if (staleId != id) release(staleId)
        }
        val wrapper = MutableContextWrapper(context)
        val webView = makeWebView(wrapper, model, presenter, stageArgb)
        val entry = Entry(webView, wrapper, id, model.reloadSerial, model.webViewRole, model.keyboardSerial, model.inputInteractive)
        entries[id] = entry
        presenter.onSessionEnded = { endedId -> release(endedId) }
        // The first load reports loadStarted (the presenter publishes), so it runs after this composition pass.
        main.post {
            if (entries[id] !== entry) return@post
            sync(entry, presenter.model, presenter)
            registrySerial += 1
        }
        scheduleCountRefresh()
        return webView
    }

    /** Stops loading, drops the clients and destroys the WebView. */
    fun release(id: String) {
        val entry = entries.remove(id) ?: return
        (entry.webView.parent as? ViewGroup)?.removeView(entry.webView)
        entry.webView.stopLoading()
        entry.webView.webChromeClient = null
        entry.webView.webViewClient = WebViewClient()
        entry.webView.destroy()
        entry.wrapper.setBaseContext(entry.wrapper.applicationContext)
        if (pageProgressSessionId == id) {
            pageProgressSessionId = ""
            pageProgress = 0
        }
        scheduleCountRefresh()
    }

    /** Terminal call end and tests: no hidden WebView keeps running. */
    fun releaseAll() {
        for (id in entries.keys.toList()) release(id)
    }

    fun hasWebView(id: String): Boolean = entries.containsKey(id)

    /** The progress leaf's value for a session (0 when another session or none is loading). */
    fun progressFor(id: String): Int = if (pageProgressSessionId == id) pageProgress else 0

    /** Loads a changed target, applies interactivity and runs the focus script once per Keyboard tap. */
    private fun sync(entry: Entry, model: BrowserStageModel, presenter: BrowserStagePresenter) {
        if (model.browserSessionId != entry.browserSessionId) return
        val interactive = model.inputInteractive
        if (entry.interactive != interactive) {
            entry.interactive = interactive
            entry.webView.isFocusable = interactive
            entry.webView.isFocusableInTouchMode = interactive
            scheduleCountRefresh()
        }
        val target = if (model.usesFixturePage) FIXTURE_TARGET else model.inputURL
        if (target.isNotEmpty() && target != entry.loadedTarget) {
            entry.loadedTarget = target
            if (model.usesFixturePage) {
                entry.webView.loadDataWithBaseURL(null, BrowserFixturePage.html, "text/html", "utf-8", null)
            } else if (BrowserNavigationPolicy.allows(scheme = Uri.parse(target).scheme ?: "")) {
                entry.webView.loadUrl(target)
            } else {
                val id = entry.browserSessionId
                val serial = entry.reloadSerial
                main.post { presenter.webViewFailed(browserSessionId = id, reloadSerial = serial, issue = BrowserLoadIssue.pageFailed) }
            }
        }
        if (model.keyboardSerial != entry.keyboardSerial) {
            entry.keyboardSerial = model.keyboardSerial
            if (model.keyboardSerial > 0 && interactive) {
                entry.webView.requestFocus()
                entry.webView.evaluateJavascript(BrowserInputScripts.focusKeyboard, null)
                val input = entry.webView.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                input?.showSoftInput(entry.webView, InputMethodManager.SHOW_IMPLICIT)
            }
        }
    }

    private fun scheduleCountRefresh() {
        main.post {
            var count = 0
            for (entry in entries.values) {
                if (entry.interactive) count += 1
            }
            if (inputViews != count) inputViews = count
        }
    }

    private fun isInteractive(id: String): Boolean = entries[id]?.interactive ?: false

    private fun isMainFrameTarget(id: String, url: String?): Boolean {
        val target = entries[id]?.loadedTarget ?: return false
        if (url == null || target == FIXTURE_TARGET) return false
        return Uri.parse(url).host == Uri.parse(target).host
    }

    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
    private fun makeWebView(context: Context, model: BrowserStageModel, presenter: BrowserStagePresenter, stageArgb: Int): WebView {
        val id = model.browserSessionId
        val serial = model.reloadSerial
        val isInputLayer = model.webViewRole == BrowserWebViewRole.input
        val webView = WebView(context)
        webView.setBackgroundColor(if (isInputLayer) android.graphics.Color.TRANSPARENT else stageArgb)
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        webView.overScrollMode = View.OVER_SCROLL_NEVER
        webView.isFocusable = model.inputInteractive
        webView.isFocusableInTouchMode = model.inputInteractive
        // The pixels are the remote browser's; TalkBack uses the native address row instead (S60 14 i).
        webView.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        // Viewers (and everyone while reconnecting or failed) never reach the page.
        webView.setOnTouchListener { _, _ -> !isInteractive(id) }
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_NO_CACHE
            setGeolocationEnabled(false)
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (entries[id]?.webView !== view) return
                pageProgressSessionId = id
                pageProgress = newProgress.coerceIn(0, 100)
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val scheme = request?.url?.scheme ?: return true
                return !BrowserNavigationPolicy.allows(scheme = scheme)
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                presenter.webViewLoadStarted(browserSessionId = id, reloadSerial = serial)
            }

            override fun onPageCommitVisible(view: WebView?, url: String?) {
                if (isInputLayer) view?.evaluateJavascript(BrowserInputScripts.installHiddenCanvas, null)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                if (isInputLayer) view?.evaluateJavascript(BrowserInputScripts.installHiddenCanvas, null)
                presenter.webViewLoadFinished(browserSessionId = id, reloadSerial = serial)
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (request?.isForMainFrame != true || error == null) return
                report(presenter, id, serial, BrowserLoadIssuePolicy.androidErrorIssue(error.errorCode))
            }

            override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, errorResponse: WebResourceResponse?) {
                if (request?.isForMainFrame != true || errorResponse == null) return
                report(presenter, id, serial, BrowserLoadIssuePolicy.httpIssue(errorResponse.statusCode))
            }

            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                // Never proceed past a bad certificate; the page's own host fails the card instead of a silent cancel.
                handler?.cancel()
                if (isMainFrameTarget(id, error?.url)) report(presenter, id, serial, BrowserLoadIssue.sslFailed)
            }

            override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                // The view is unusable after this: release it, show the failure state, keep the call running.
                report(presenter, id, serial, BrowserLoadIssue.rendererGone)
                main.post { release(id) }
                return true
            }
        }
        return webView
    }

    private fun report(presenter: BrowserStagePresenter, id: String, serial: Int, issue: BrowserLoadIssue) {
        if (issue == BrowserLoadIssue.none) return
        presenter.webViewFailed(browserSessionId = id, reloadSerial = serial, issue = issue)
    }
}
