package conclave.module

import android.webkit.CookieManager as AndroidCookieManager
import java.net.CookieHandler
import java.net.CookiePolicy
import java.net.CookieManager as JavaCookieManager
import java.net.HttpCookie
import java.net.URI

object NativeAuthSessionBridge {
    private val lock = Any()
    private val javaCookieManager = JavaCookieManager(null, CookiePolicy.ACCEPT_ALL)

    fun install() {
        synchronized(lock) {
            if (CookieHandler.getDefault() !is JavaCookieManager) {
                CookieHandler.setDefault(javaCookieManager)
            }
            try {
                AndroidCookieManager.getInstance().setAcceptCookie(true)
            } catch (_: Throwable) {
            }
        }
    }

    fun cookieHeader(forURL: String): String? {
        install()
        val headers = mutableListOf<String>()

        try {
            AndroidCookieManager.getInstance().getCookie(forURL)?.let { value ->
                if (value.isNotBlank()) headers.add(value)
            }
        } catch (_: Throwable) {
        }

        try {
            val cookieMap = javaCookieManager.get(uri(forURL), emptyMap())
            cookieMap["Cookie"]?.let { values ->
                headers.add(values.joinToString("; "))
            }
        } catch (_: Throwable) {
        }

        return normalizedCookieHeader(headers)
    }

    fun storeSetCookieHeader(setCookieHeader: String, forURL: String) {
        install()
        val cookies = splitSetCookieHeader(setCookieHeader)
        if (cookies.isEmpty()) return

        val androidCookieManager = try {
            AndroidCookieManager.getInstance()
        } catch (_: Throwable) {
            null
        }
        val uri = uri(forURL)

        for (cookie in cookies) {
            try {
                androidCookieManager?.setCookie(forURL, cookie)
            } catch (_: Throwable) {
            }

            try {
                HttpCookie.parse(cookie).forEach { parsedCookie ->
                    javaCookieManager.cookieStore.add(uri, parsedCookie)
                }
            } catch (_: Throwable) {
            }
        }

        try {
            androidCookieManager?.flush()
        } catch (_: Throwable) {
        }
    }

    fun clearCookies() {
        install()
        try {
            val cookieManager = AndroidCookieManager.getInstance()
            cookieManager.removeAllCookies(null)
            cookieManager.flush()
        } catch (_: Throwable) {
        }

        try {
            javaCookieManager.cookieStore.removeAll()
        } catch (_: Throwable) {
        }

        try {
            val cookieHandler = CookieHandler.getDefault()
            if (cookieHandler is JavaCookieManager && cookieHandler !== javaCookieManager) {
                cookieHandler.cookieStore.removeAll()
            }
        } catch (_: Throwable) {
        }
    }

    private fun uri(urlString: String): URI = try {
        URI(urlString)
    } catch (_: Throwable) {
        URI.create("http://localhost")
    }

    private fun normalizedCookieHeader(headers: List<String>): String? {
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
        return pairs.values.joinToString("; ").takeIf { it.isNotBlank() }
    }

    private fun splitSetCookieHeader(header: String): List<String> {
        val value = header.trim()
        if (value.isEmpty()) return emptyList()

        val result = mutableListOf<String>()
        var start = 0
        var index = 0

        while (index < value.length) {
            if (value[index] == ',' && looksLikeCookieStart(value, index + 1)) {
                value.substring(start, index).trim().takeIf { it.isNotEmpty() }?.let(result::add)
                start = index + 1
            }
            index += 1
        }

        value.substring(start).trim().takeIf { it.isNotEmpty() }?.let(result::add)
        return result
    }

    private fun looksLikeCookieStart(value: String, offset: Int): Boolean {
        var index = offset
        while (index < value.length && value[index].isWhitespace()) {
            index += 1
        }

        val equalsIndex = value.indexOf('=', startIndex = index)
        if (equalsIndex <= index) return false

        val nextSemicolon = value.indexOf(';', startIndex = index).let { if (it == -1) Int.MAX_VALUE else it }
        val nextComma = value.indexOf(',', startIndex = index).let { if (it == -1) Int.MAX_VALUE else it }
        if (equalsIndex > minOf(nextSemicolon, nextComma)) return false

        val name = value.substring(index, equalsIndex).trim()
        return name.isNotEmpty() && name.all { it.isLetterOrDigit() || it == '-' || it == '_' || it == '.' }
    }
}
