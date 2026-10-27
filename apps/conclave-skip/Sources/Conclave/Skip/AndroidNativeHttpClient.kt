package conclave.module

import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import okhttp3.Call
import okhttp3.Dns
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

object AndroidNativeHttpClient {
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        .dns(Ipv4PreferredDns)
        .connectTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    private val assistantClient = client.newBuilder()
        .readTimeout(120, TimeUnit.SECONDS)
        .callTimeout(150, TimeUnit.SECONDS)
        .build()

    /**
     * S40 CH7 (CHT-7): the streamed answer reads frames as they arrive, so the whole call may outlast the buffered
     * client's 150 s cap (web search and tool rounds); the 120 s read timeout still ends a stalled stream.
     */
    private val assistantStreamClient = client.newBuilder()
        .readTimeout(120, TimeUnit.SECONDS)
        .callTimeout(300, TimeUnit.SECONDS)
        .build()

    /** One running assistant stream: the call once it exists, and whether Swift cancelled it before or after that. */
    private class AssistantStream {
        @Volatile var call: Call? = null
        @Volatile var cancelled = false
    }

    private val assistantStreams = ConcurrentHashMap<String, AssistantStream>()

    fun requestJson(
        method: String,
        url: String,
        body: String?,
        accept: String?,
        contentType: String?,
        origin: String?,
        clientId: String?,
        cookieHeader: String?,
        callback: (String?, String?) -> Unit
    ) {
        thread(name = "ConclaveNativeHttp") {
            try {
                callback(
                    requestJsonBlocking(
                        method = method,
                        url = url,
                        body = body,
                        accept = accept,
                        contentType = contentType,
                        origin = origin,
                        clientId = clientId,
                        cookieHeader = cookieHeader
                    ),
                    null
                )
            } catch (error: Throwable) {
                debugLog("[HTTP] Android native request failed: ${error}")
                callback(null, error.localizedMessage ?: error.toString())
            }
        }
    }

    fun requestAssistant(
        method: String,
        url: String,
        body: String?,
        accept: String?,
        contentType: String?,
        authorization: String?,
        origin: String?,
        cookieHeader: String?,
        callback: (String?, String?) -> Unit
    ) {
        thread(name = "ConclaveAssistantHttp") {
            try {
                callback(
                    requestJsonBlocking(
                        method = method,
                        url = url,
                        body = body,
                        accept = accept,
                        contentType = contentType,
                        authorization = authorization,
                        origin = origin,
                        clientId = null,
                        cookieHeader = cookieHeader,
                        httpClient = assistantClient
                    ),
                    null
                )
            } catch (error: Throwable) {
                debugLog("[HTTP] Android native assistant request failed: ${error}")
                callback(null, error.localizedMessage ?: error.toString())
            }
        }
    }

    /**
     * S40 CH7 (CHT-7): the assistant's server-sent events, delivered as they arrive. The reader thread hands [onChunk]
     * one complete frame at a time (its lines plus the blank line that ends it; UTF-8 is decoded per line, so no code
     * point is split), then calls [onDone] once with the envelope `{statusCode, body, setCookieHeaders}` (`body` is the
     * error body for a non-2xx answer, "" otherwise) or with an error message. Both callbacks run on the reader thread;
     * the Swift side posts them to the main actor in order. [cancelAssistantStream] with the same [requestId] cancels
     * the call, before or after it starts.
     */
    fun requestAssistantStream(
        requestId: String,
        method: String,
        url: String,
        body: String?,
        accept: String?,
        contentType: String?,
        authorization: String?,
        origin: String?,
        cookieHeader: String?,
        onChunk: (String) -> Unit,
        onDone: (String?, String?) -> Unit
    ) {
        val stream = AssistantStream()
        assistantStreams[requestId] = stream
        thread(name = "ConclaveAssistantStream") {
            try {
                val call = assistantStreamClient.newCall(
                    buildRequest(
                        method = method,
                        url = url,
                        body = body,
                        accept = accept,
                        contentType = contentType,
                        authorization = authorization,
                        origin = origin,
                        clientId = null,
                        cookieHeader = cookieHeader
                    )
                )
                // Publish the call before reading the flag; cancel writes the flag before reading the call, so one of
                // the two always sees the other.
                stream.call = call
                if (stream.cancelled) call.cancel()
                val requestStartedAt = System.nanoTime()
                call.execute().use { response ->
                    val setCookieHeaders = JSONArray()
                    for (header in response.headers("Set-Cookie")) {
                        setCookieHeaders.put(header)
                    }
                    var errorBody = ""
                    if (response.isSuccessful) {
                        val source = response.body?.source()
                        if (source != null) {
                            val frame = StringBuilder()
                            while (true) {
                                val line = source.readUtf8Line() ?: break
                                frame.append(line).append('\n')
                                if (line.isEmpty()) {
                                    onChunk(frame.toString())
                                    frame.setLength(0)
                                }
                            }
                            if (frame.isNotEmpty()) onChunk(frame.toString())
                        }
                    } else {
                        errorBody = response.body?.string().orEmpty()
                    }
                    NativePerformanceDiagnostics.timing(
                        "http_assistant_stream",
                        requestStartedAt,
                        "url=${redactedURLForLog(url)} status=${response.code}"
                    )
                    onDone(
                        JSONObject()
                            .put("statusCode", response.code)
                            .put("body", errorBody)
                            .put("setCookieHeaders", setCookieHeaders)
                            .toString(),
                        null
                    )
                }
            } catch (error: Throwable) {
                debugLog("[HTTP] Android native assistant stream failed: ${error}")
                onDone(null, error.localizedMessage ?: error.toString())
            } finally {
                assistantStreams.remove(requestId)
            }
        }
    }

    /** Cancels a running [requestAssistantStream]; a no-op once it finished. */
    fun cancelAssistantStream(requestId: String) {
        val stream = assistantStreams.remove(requestId) ?: return
        stream.cancelled = true
        stream.call?.cancel()
    }

    private fun requestJsonBlocking(
        method: String,
        url: String,
        body: String?,
        accept: String?,
        contentType: String?,
        authorization: String? = null,
        origin: String?,
        clientId: String?,
        cookieHeader: String?,
        httpClient: OkHttpClient = client
    ): String {
        val request = buildRequest(
            method = method,
            url = url,
            body = body,
            accept = accept,
            contentType = contentType,
            authorization = authorization,
            origin = origin,
            clientId = clientId,
            cookieHeader = cookieHeader
        )
        val normalizedMethod = request.method
        val requestStartedAt = System.nanoTime()
        httpClient.newCall(request).execute().use { response ->
            val setCookieHeaders = JSONArray()
            for (header in response.headers("Set-Cookie")) {
                setCookieHeaders.put(header)
            }

            NativePerformanceDiagnostics.timing(
                "http_request",
                requestStartedAt,
                "method=$normalizedMethod url=${redactedURLForLog(url)} status=${response.code}"
            )

            return JSONObject()
                .put("statusCode", response.code)
                .put("body", response.body?.string().orEmpty())
                .put("setCookieHeaders", setCookieHeaders)
                // S10 0.8 C18 (HD request B5-T5 R4): the join's Retry-After for the one automatic retry.
                .put("retryAfter", response.header("Retry-After").orEmpty())
                .toString()
        }
    }

    /** The request every path sends: method and body, the optional headers, and the stored plus provided cookies. */
    private fun buildRequest(
        method: String,
        url: String,
        body: String?,
        accept: String?,
        contentType: String?,
        authorization: String?,
        origin: String?,
        clientId: String?,
        cookieHeader: String?
    ): Request {
        val normalizedMethod = method.trim().uppercase().ifEmpty { "GET" }
        val requestBuilder = Request.Builder().url(url)
        requestBuilder.method(normalizedMethod, requestBodyFor(normalizedMethod, body, contentType))

        val normalizedAccept = accept?.trim().orEmpty()
        if (normalizedAccept.isNotEmpty()) {
            requestBuilder.header("Accept", normalizedAccept)
        }

        val normalizedContentType = contentType?.trim().orEmpty()
        if (normalizedContentType.isNotEmpty()) {
            requestBuilder.header("Content-Type", normalizedContentType)
        }

        val normalizedAuthorization = authorization?.trim().orEmpty()
        if (normalizedAuthorization.isNotEmpty()) {
            requestBuilder.header("Authorization", normalizedAuthorization)
        }

        val normalizedOrigin = origin?.trim().orEmpty()
        if (normalizedOrigin.isNotEmpty()) {
            requestBuilder.header("Origin", normalizedOrigin)
        }

        val normalizedClientId = clientId?.trim().orEmpty()
        if (normalizedClientId.isNotEmpty()) {
            requestBuilder.header("x-sfu-client", normalizedClientId)
        }

        val cookieStartedAt = System.nanoTime()
        val storedCookieHeader = try {
            NativeAuthSessionBridge.cookieHeader(url).orEmpty()
        } catch (_: Throwable) {
            ""
        }
        NativePerformanceDiagnostics.timing(
            "http_cookie_header",
            cookieStartedAt,
            "url=${redactedURLForLog(url)} stored=${storedCookieHeader.isNotBlank()} provided=${!cookieHeader.isNullOrBlank()}"
        )

        val mergedCookieHeader = mergeCookieHeaders(
            listOf(cookieHeader?.trim().orEmpty(), storedCookieHeader)
        )
        if (mergedCookieHeader.isNotEmpty()) {
            requestBuilder.header("Cookie", mergedCookieHeader)
        }
        return requestBuilder.build()
    }

    private fun mergeCookieHeaders(headers: List<String>): String {
        val pairs = LinkedHashMap<String, String>()
        for (header in headers) {
            header
                .split(";")
                .map { it.trim() }
                .filter { it.isNotEmpty() && it.contains("=") }
                .forEach { pair ->
                    val name = pair.substringBefore("=").trim()
                    if (name.isNotEmpty()) pairs[name] = pair
                }
        }
        return pairs.values.joinToString("; ")
    }

    private fun redactedURLForLog(url: String): String {
        val queryIndex = url.indexOf('?')
        return if (queryIndex == -1) url else url.substring(0, queryIndex) + "?..."
    }

    private fun requestBodyFor(method: String, body: String?, contentType: String?): okhttp3.RequestBody? {
        if (method == "GET" || method == "HEAD") return null
        val mediaType = contentType?.trim()?.takeIf { it.isNotEmpty() }?.toMediaType() ?: jsonMediaType
        return (body ?: "").toRequestBody(mediaType)
    }

    private object Ipv4PreferredDns : Dns {
        override fun lookup(hostname: String): List<InetAddress> {
            val addresses = Dns.SYSTEM.lookup(hostname)
            if (!shouldPreferIpv4(hostname)) return addresses

            val ipv4 = addresses.filterIsInstance<Inet4Address>()
            if (ipv4.isEmpty()) return addresses
            return ipv4 + addresses.filterNot { it is Inet4Address }
        }

        private fun shouldPreferIpv4(hostname: String): Boolean {
            val normalized = hostname.trim().lowercase()
            return normalized == "conclave.acmvit.in" || normalized == "www.conclave.acmvit.in"
        }
    }
}
