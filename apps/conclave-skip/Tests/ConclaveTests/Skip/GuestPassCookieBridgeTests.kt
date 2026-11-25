package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.junit.Rule

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class GuestPassCookieBridgeTests {
    @get:Rule val urlHandlerSandbox = SharedUrlHandlerSandbox()
    private val attributes = "Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax"

    // What the join route reads back: the value under the cookie name. The jar may send a
    // cookie that was set with Max-Age in double quotes, which the route accepts.
    private fun sentCookie(name: String, url: String): String? =
        NativeAuthSessionBridge.cookieHeader(url).orEmpty()
            .split(";")
            .map { it.trim() }
            .lastOrNull { it.substringBefore("=") == name }
            ?.substringAfter("=")
            ?.removeSurrounding("\"")

    @Test fun theGuestPassFromAJoinResponseRidesOnTheNextJoinRequest() {
        val joinURL = "http://127.0.0.1:3000/api/sfu/join"
        val name = "conclave-guest-0a1b2c3d"
        val pass = "local-pass-" + java.util.UUID.randomUUID().toString()
        NativeAuthSessionBridge.storeSetCookieHeader("$name=$pass; $attributes", joinURL)
        try {
            assertEquals(pass, sentCookie(name, joinURL))
        } finally {
            NativeAuthSessionBridge.storeSetCookieHeader("$name=; Max-Age=0; Path=/", joinURL)
        }
    }

    @Test fun theProductionGuestPassRidesOnTheNextHttpsJoinRequest() {
        val joinURL = "https://guest-pass.conclave.test/api/sfu/join"
        val name = "__Host-conclave-guest-0a1b2c3d"
        val pass = "live-pass-" + java.util.UUID.randomUUID().toString()
        NativeAuthSessionBridge.storeSetCookieHeader("$name=$pass; $attributes; Secure", joinURL)
        try {
            assertEquals(pass, sentCookie(name, joinURL))
        } finally {
            NativeAuthSessionBridge.storeSetCookieHeader("$name=; Max-Age=0; Path=/; Secure", joinURL)
        }
    }
}
