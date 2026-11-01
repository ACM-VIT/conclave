package conclave.module

import android.os.Looper
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.webrtc.VideoTrack
import sun.misc.Unsafe

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
@LooperMode(LooperMode.Mode.PAUSED)
class S6CFenceRegressionTests {
    private fun unsafe(): Unsafe = Unsafe::class.java.getDeclaredField("theUnsafe").let {
        it.isAccessible = true
        it.get(null) as Unsafe
    }

    private class RecordingTrack : VideoTrack(1L) {
        var live = true
        override fun setEnabled(enable: Boolean): Boolean { live = enable; return true }
    }

    @Test fun aCancelledCookieTransactionCannotOverwriteANewerAcceptedSession() {
        val url = skip.foundation.URL(string = "http://127.0.0.1:3000/api/auth/get-session")
        val name = "better-auth.s6c-" + java.util.UUID.randomUUID().toString()
        fun response(value: String) = NativeAuthHTTPResult(
            data = skip.foundation.Data(platformValue = byteArrayOf()), statusCode = 200,
            setCookieHeaders = skip.lib.Array(listOf("$name=$value; Path=/; HttpOnly")))
        val old = NativeAuthCookieTransaction(NativeAuthService.beginAuthentication())
        old.stage(response("old"), url)
        assertTrue(old.cookieHeader(url).orEmpty().contains("$name=old"))
        assertFalse(NativeAuthSessionBridge.cookieHeader(url.absoluteString).orEmpty().contains(name))
        val newer = NativeAuthCookieTransaction(NativeAuthService.beginAuthentication())
        newer.stage(response("new"), url)
        newer.commit()
        try {
            old.commit()
            fail("A superseded transaction committed its cookies")
        } catch (error: NativeAuthError) {
            assertEquals(NativeAuthErrorKind.cancelled, error.kind)
        }
        assertTrue(NativeAuthSessionBridge.cookieHeader(url.absoluteString).orEmpty().contains("$name=new"))
        NativeAuthSessionBridge.storeSetCookieHeader("$name=; Max-Age=0; Path=/", url.absoluteString)
    }

}
