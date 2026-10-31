package conclave.module

import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

object TranscriptWebSocketBridge {

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null

    fun connect(url: String, onEvent: (String, String?) -> Unit) {
        close()

        val httpUrl = url
            .replaceFirst("wss://", "https://")
            .replaceFirst("ws://", "http://")

        val request = Request.Builder().url(httpUrl).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {

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
