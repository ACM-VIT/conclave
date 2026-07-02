package conclave.module

import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/// OkHttp-backed WebSocket used by the transcript worker stream on Android.
/// Mirrors the small surface the Swift `TranscriptWebSocket` expects: a single
/// active connection driven by a `(event, payload)` callback where `event` is
/// one of "open" / "message" / "closed" / "error".
object TranscriptWebSocketBridge {
    // No read timeout: the socket stays open for the life of the session. A ping
    // keeps intermediaries from dropping an idle connection between captions.
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null

    fun connect(url: String, onEvent: (String, String?) -> Unit) {
        close()

        // OkHttp's HttpUrl only accepts http/https; it upgrades to the WebSocket
        // protocol internally, so translate the ws/wss scheme up front.
        val httpUrl = url
            .replaceFirst("wss://", "https://")
            .replaceFirst("ws://", "http://")

        val request = Request.Builder().url(httpUrl).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            // Ignore callbacks from a socket that is no longer the active one, so a
            // stale close/error from a replaced connection can't disrupt the new one.
            private fun emit(ws: WebSocket, event: String, payload: String?) {
                if (webSocket === ws) {
                    onEvent(event, payload)
                }
            }

            override fun onOpen(ws: WebSocket, response: Response) {
                emit(ws, "open", null)
            }

            override fun onMessage(ws: WebSocket, text: String) {
                emit(ws, "message", text)
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                ws.close(1000, null)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                emit(ws, "closed", reason)
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                emit(ws, "error", t.localizedMessage ?: t.toString())
            }
        })
    }

    fun send(text: String) {
        webSocket?.send(text)
    }

    fun close() {
        webSocket?.close(1000, null)
        webSocket = null
    }
}
