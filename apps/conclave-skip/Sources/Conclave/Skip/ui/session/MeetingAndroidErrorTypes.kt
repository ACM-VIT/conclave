package conclave.module

import android.os.Build

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
