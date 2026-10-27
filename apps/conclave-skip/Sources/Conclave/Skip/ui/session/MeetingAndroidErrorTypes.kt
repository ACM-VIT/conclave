package conclave.module

import android.os.Build

/**
 * WP2-S2a typed Android rows of the S70 7 d classifier table. The transpiled MeetingErrorClassifier calls this under
 * `#if SKIP`; it answers a MeetingErrorCategory raw value, or "" when the error carries no typed evidence (the Swift
 * side then reads the message table). Kotlin throwables reach Swift wrapped in skip.lib.ErrorException, so the cause
 * chain is unwrapped first. ForegroundServiceStartNotAllowedException is an API 31 class: it is compared by name and
 * only from API 31, so the library never links it.
 */
internal object MeetingAndroidErrorTypes {
    const val FOREGROUND_SERVICE_NOT_ALLOWED = "android.app.ForegroundServiceStartNotAllowedException"

    fun categoryName(error: Any?, isNetworkOffline: Boolean): String =
        categoryName(error, isNetworkOffline, Build.VERSION.SDK_INT)

    fun categoryName(error: Any?, isNetworkOffline: Boolean, sdkInt: Int): String {
        val throwable = unwrap(error) ?: return ""
        return when {
            throwable is java.util.concurrent.CancellationException -> "cancelled"
            throwable is java.net.UnknownHostException -> if (isNetworkOffline) "offline" else "serverUnreachable"
            throwable is java.net.ConnectException -> "serverUnreachable"
            throwable is java.net.SocketTimeoutException -> "timedOut"
            else -> classNameCategory(throwable.javaClass.name, sdkInt)
        }
    }

    /** Name-only rows (the API 31 class). */
    fun classNameCategory(className: String, sdkInt: Int): String =
        if (sdkInt >= 31 && className == FOREGROUND_SERVICE_NOT_ALLOWED) "platformRefused" else ""

    private fun unwrap(error: Any?): Throwable? {
        var current = error as? Throwable ?: return null
        var depth = 0
        while (current is skip.lib.ErrorException && depth < 4) {
            val cause = current.cause ?: break
            if (cause === current) break
            current = cause
            depth += 1
        }
        return current
    }
}
