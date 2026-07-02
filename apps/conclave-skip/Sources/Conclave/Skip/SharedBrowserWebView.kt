package conclave.module

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView

private fun String.webViewLogUrl(): String {
    val trimmed = trim()
    return if (trimmed.length <= 180) trimmed else trimmed.take(177) + "..."
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun SharedBrowserWebView(urlString: String) {
    val context = LocalContext.current
    var lastLoggedSize by remember { mutableStateOf("") }
    val webView = remember {
        WebView(context).apply {
            setBackgroundColor(android.graphics.Color.BLACK)
            webViewClient = object : WebViewClient() {
                private var pageStartedAtNs = 0L

                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    pageStartedAtNs = System.nanoTime()
                    NativePerformanceDiagnostics.event(
                        "webview_page_started",
                        "url=${url.orEmpty().webViewLogUrl()}"
                    )
                    super.onPageStarted(view, url, favicon)
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    val startedAtNs = if (pageStartedAtNs == 0L) System.nanoTime() else pageStartedAtNs
                    NativePerformanceDiagnostics.timingAlways(
                        "webview_page_finished",
                        startedAtNs,
                        "progress=${view?.progress ?: -1} url=${url.orEmpty().webViewLogUrl()}"
                    )
                    super.onPageFinished(view, url)
                }

                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: WebResourceError?
                ) {
                    if (request?.isForMainFrame == true) {
                        NativePerformanceDiagnostics.event(
                            "webview_page_error",
                            "code=${error?.errorCode ?: 0} description=${error?.description ?: "unknown"} " +
                                "url=${request.url?.toString().orEmpty().webViewLogUrl()}"
                        )
                    }
                    super.onReceivedError(view, request, error)
                }

                override fun onReceivedHttpError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    errorResponse: WebResourceResponse?
                ) {
                    if (request?.isForMainFrame == true) {
                        NativePerformanceDiagnostics.event(
                            "webview_http_error",
                            "status=${errorResponse?.statusCode ?: 0} " +
                                "reason=${errorResponse?.reasonPhrase ?: "unknown"} " +
                                "url=${request.url?.toString().orEmpty().webViewLogUrl()}"
                        )
                    }
                    super.onReceivedHttpError(view, request, errorResponse)
                }

                override fun onReceivedSslError(
                    view: WebView?,
                    handler: SslErrorHandler?,
                    error: SslError?
                ) {
                    NativePerformanceDiagnostics.event(
                        "webview_ssl_error",
                        "primary=${error?.primaryError ?: -1} url=${error?.url.orEmpty().webViewLogUrl()}"
                    )
                    handler?.cancel()
                }
            }
            webChromeClient = WebChromeClient()
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
    }

    DisposableEffect(webView) {
        NativePerformanceDiagnostics.event(
            "webview_mount",
            "url=${urlString.webViewLogUrl()}"
        )
        onDispose {
            NativePerformanceDiagnostics.event(
                "webview_dispose",
                "url=${webView.url.orEmpty().webViewLogUrl()}"
            )
            webView.stopLoading()
            webView.destroy()
        }
    }

    AndroidView(
        modifier = Modifier
            .fillMaxSize()
            .onGloballyPositioned { coordinates ->
                val size = coordinates.size
                val sizeKey = "${size.width}x${size.height}"
                if (lastLoggedSize != sizeKey) {
                    lastLoggedSize = sizeKey
                    NativePerformanceDiagnostics.event(
                        "webview_size",
                        "width=${size.width} height=${size.height} url=${urlString.webViewLogUrl()}"
                    )
                }
            },
        factory = {
            NativePerformanceDiagnostics.event(
                "webview_factory",
                "url=${urlString.webViewLogUrl()}"
            )
            webView
        },
        update = { view ->
            if (urlString.isBlank()) {
                NativePerformanceDiagnostics.event("webview_blank_url")
            } else if (view.url != urlString) {
                NativePerformanceDiagnostics.event(
                    "webview_load_url",
                    "current=${view.url.orEmpty().webViewLogUrl()} next=${urlString.webViewLogUrl()}"
                )
                view.loadUrl(urlString)
            }
        }
    )
}
