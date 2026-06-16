package conclave.module

import android.webkit.CookieManager as AndroidCookieManager
import java.net.CookieHandler
import java.net.CookieManager as JavaCookieManager

object NativeAuthSessionBridge {
    fun clearCookies() {
        try {
            val cookieManager = AndroidCookieManager.getInstance()
            cookieManager.removeAllCookies(null)
            cookieManager.flush()
        } catch (_: Throwable) {
        }

        try {
            val cookieHandler = CookieHandler.getDefault()
            if (cookieHandler is JavaCookieManager) {
                cookieHandler.cookieStore.removeAll()
            }
        } catch (_: Throwable) {
        }
    }
}
