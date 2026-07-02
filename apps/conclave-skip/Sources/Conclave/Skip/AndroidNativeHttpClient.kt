package conclave.module

import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
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

    private fun requestJsonBlocking(
        method: String,
        url: String,
        body: String?,
        accept: String?,
        contentType: String?,
        origin: String?,
        clientId: String?,
        cookieHeader: String?,
        httpClient: OkHttpClient = client
    ): String {
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

        val requestStartedAt = System.nanoTime()
        httpClient.newCall(requestBuilder.build()).execute().use { response ->
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
                .toString()
        }
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
