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

        for (url in cookieURLStrings(forURL)) {
            try {
                AndroidCookieManager.getInstance().getCookie(url)?.let { value ->
                    if (value.isNotBlank()) headers.add(value)
                }
            } catch (_: Throwable) {
            }
        }

        for (uri in cookieURIs(forURL)) {
            try {
                val cookieMap = javaCookieManager.get(uri, emptyMap())
                cookieMap["Cookie"]?.let { values ->
                    headers.add(values.joinToString("; "))
                }
            } catch (_: Throwable) {
            }
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
        val urls = cookieURLStrings(forURL)
        val uris = cookieURIs(forURL)

        for (cookie in cookies) {
            for (url in urls) {
                try {
                    androidCookieManager?.setCookie(url, cookie)
                } catch (_: Throwable) {
                }
            }

            for (uri in uris) {
                try {
                    HttpCookie.parse(cookie).forEach { parsedCookie ->
                        javaCookieManager.cookieStore.add(uri, parsedCookie)
                    }
                } catch (_: Throwable) {
                }
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

    fun clearCookies(forURL: String) {
        install()
        val urls = cookieURLStrings(forURL)
        val uris = cookieURIs(forURL)
        val targetHosts = uris.mapNotNull { it.host?.lowercase() }.toSet()
        val authCookieNames = authCookieNames(urls, targetHosts)

        try {
            val cookieManager = AndroidCookieManager.getInstance()
            for (url in urls) {
                for (name in authCookieNames) {
                    expireAndroidCookie(cookieManager, url, name)
                    for (domain in cookieDomainCandidates(targetHosts)) {
                        expireAndroidCookie(cookieManager, url, name, domain)
                    }
                }
            }
            cookieManager.flush()
        } catch (_: Throwable) {
        }

        removeScopedAuthCookies(javaCookieManager, uris, targetHosts)

        try {
            val cookieHandler = CookieHandler.getDefault()
            if (cookieHandler is JavaCookieManager && cookieHandler !== javaCookieManager) {
                removeScopedAuthCookies(cookieHandler, uris, targetHosts)
            }
        } catch (_: Throwable) {
        }
    }

    private fun uri(urlString: String): URI = try {
        URI(urlString)
    } catch (_: Throwable) {
        URI.create("http://localhost")
    }

    private fun cookieURLStrings(urlString: String): List<String> =
        cookieURIs(urlString).map { it.toString() }.distinct()

    private fun cookieURIs(urlString: String): List<URI> {
        val original = uri(urlString)
        val host = original.host?.lowercase() ?: return listOf(original)
        if (host !in loopbackCookieHosts) return listOf(original)

        val aliases = loopbackCookieHosts + host
        return aliases.mapNotNull { alias ->
            try {
                URI(
                    original.scheme ?: "http",
                    original.userInfo,
                    alias,
                    original.port,
                    original.path,
                    original.query,
                    original.fragment
                )
            } catch (_: Throwable) {
                null
            }
        }.distinct()
    }

    private val loopbackCookieHosts: Set<String>
        get() = linkedSetOf(
            "localhost",
            "127.0.0.1",
            "0.0.0.0"
        ).apply {
            if (AndroidRuntimeConfig.isDebuggable()) {
                add(androidEmulatorLoopbackHost("2"))
                add(androidEmulatorLoopbackHost("3"))
            }
        }

    private fun androidEmulatorLoopbackHost(thirdOctet: String): String =
        listOf("10", "0", thirdOctet, "2").joinToString(".")

    private val fallbackAuthCookieNames = linkedSetOf(
        "better-auth.session_token",
        "__Secure-better-auth.session_token",
        "__Host-better-auth.session_token",
        "better-auth.session_data",
        "__Secure-better-auth.session_data",
        "__Host-better-auth.session_data",
        "better-auth.csrf_token",
        "__Secure-better-auth.csrf_token",
        "__Host-better-auth.csrf_token"
    )

    private fun authCookieNames(urls: List<String>, targetHosts: Set<String>): Set<String> {
        val names = linkedSetOf<String>()
        try {
            val cookieManager = AndroidCookieManager.getInstance()
            for (url in urls) {
                cookieManager.getCookie(url)
                    ?.split(";")
                    ?.map { it.trim() }
                    ?.filter { it.contains("=") }
                    ?.map { it.substringBefore("=").trim() }
                    ?.filter { isAuthCookieName(it) }
                    ?.forEach(names::add)
            }
        } catch (_: Throwable) {
        }

        try {
            javaCookieManager.cookieStore.cookies
                .filter { cookie -> isAuthCookieName(cookie.name) && cookieMatchesHost(cookie, targetHosts) }
                .map { cookie -> cookie.name }
                .forEach(names::add)
        } catch (_: Throwable) {
        }

        names.addAll(fallbackAuthCookieNames)
        return names
    }

    private fun expireAndroidCookie(
        cookieManager: AndroidCookieManager,
        url: String,
        name: String,
        domain: String? = null
    ) {
        val domainAttribute = domain?.let { "; Domain=$it" } ?: ""
        try {
            cookieManager.setCookie(
                url,
                "$name=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/$domainAttribute"
            )
        } catch (_: Throwable) {
        }
    }

    private fun removeScopedAuthCookies(
        cookieManager: JavaCookieManager,
        uris: List<URI>,
        targetHosts: Set<String>
    ) {
        try {
            val store = cookieManager.cookieStore
            for (cookie in store.cookies.toList()) {
                if (!isAuthCookieName(cookie.name) || !cookieMatchesHost(cookie, targetHosts)) {
                    continue
                }
                for (uri in uris) {
                    try {
                        store.remove(uri, cookie)
                    } catch (_: Throwable) {
                    }
                }
            }
        } catch (_: Throwable) {
        }
    }

    private fun cookieDomainCandidates(targetHosts: Set<String>): List<String> {
        val domains = linkedSetOf<String>()
        for (host in targetHosts) {
            if (host.isBlank()) continue
            domains.add(host)
            if (!host.startsWith(".")) {
                domains.add(".$host")
            }
        }
        return domains.toList()
    }

    private fun cookieMatchesHost(cookie: HttpCookie, targetHosts: Set<String>): Boolean {
        val domain = cookie.domain?.trim('.')?.lowercase()
        if (domain.isNullOrBlank()) return true
        return targetHosts.any { host ->
            host == domain || host.endsWith(".$domain") || domain.endsWith(".$host")
        }
    }

    private fun isAuthCookieName(name: String): Boolean {
        val normalized = name.lowercase()
        return normalized.contains("better-auth") ||
            normalized.contains("session") ||
            normalized.contains("auth")
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
