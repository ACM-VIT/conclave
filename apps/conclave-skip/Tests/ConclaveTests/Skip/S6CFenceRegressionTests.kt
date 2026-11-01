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

    @Test fun aHoldSynchronouslySilencesTheTrackAndInvalidatesPendingEnables() {
        val allocator = unsafe()
        val media = allocator.allocateInstance(WebRTCClient::class.java) as WebRTCClient
        val track = allocator.allocateInstance(RecordingTrack::class.java) as RecordingTrack
        track.live = true
        val generation = WebRTCClient::class.java.getDeclaredField("localVideoOffIntentGeneration").apply { isAccessible = true }
        val enabled = WebRTCClient::class.java.getDeclaredField("localVideoEnabled").apply { isAccessible = true }
        WebRTCClient::class.java.getDeclaredField("localVideoTrack").apply { isAccessible = true }.set(media, track)
        enabled.setBoolean(media, true)
        val pendingEnableGeneration = generation.getInt(media)
        media.fenceLocalVideoForHold()
        assertFalse(track.live)
        assertFalse(media.localVideoEnabled)
        assertNotEquals(pendingEnableGeneration, generation.getInt(media))
        val heldGeneration = generation.getInt(media)
        media.fenceLocalVideoForHold()
        assertNotEquals(heldGeneration, generation.getInt(media))
        assertFalse(track.live)
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

    private fun set(manager: SocketIOManager, field: String, value: Any?) {
        SocketIOManager::class.java.getDeclaredField(field).apply { isAccessible = true }.set(manager, value)
    }

    private fun register(manager: SocketIOManager, socket: Socket) {
        SocketIOManager::class.java.getDeclaredMethod("registerEventHandlers", Socket::class.java)
            .apply { isAccessible = true }.invoke(manager, socket)
    }

    private fun deliver(socket: Socket, event: String, packet: JSONObject) {
        val listeners = socket.listeners(event).toList()
        assertTrue(listeners.isNotEmpty())
        var failure: Throwable? = null
        val worker = Thread {
            try { listeners.forEach { it.call(packet) } } catch (error: Throwable) { failure = error }
        }
        worker.start()
        worker.join(5000)
        assertFalse(worker.isAlive)
        failure?.let { throw it }
    }

    private fun checkDelivery(assistant: Boolean, replaceBeforeDelivery: Boolean) {
        val manager = SocketIOManager()
        val origin = IO.socket("http://127.0.0.1:1")
        set(manager, "socket", origin)
        set(manager, "activeRoomId", "same-room")
        set(manager, "activeRoomAliases", setOf("same-room"))
        register(manager, origin)
        var deliveries = 0
        var onMain = false
        manager.onConclaveAssistantPacket = { deliveries += 1; onMain = Looper.myLooper() == Looper.getMainLooper() }
        manager.onParticipantMediaPermissionsChanged = { deliveries += 1; onMain = Looper.myLooper() == Looper.getMainLooper() }
        val event = if (assistant) SocketEvent.conclaveMessage else SocketEvent.participantMediaPermissionsChanged
        val packet = if (assistant) JSONObject("""{"id":"answer","roomId":"same-room","reasoning":"pending"}""")
            else JSONObject("""{"roomId":"same-room","unmuteAllowed":false,"videoAllowed":false}""")
        deliver(origin, event, packet)
        assertEquals(0, deliveries)
        if (replaceBeforeDelivery) set(manager, "socket", IO.socket("http://127.0.0.1:2"))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(if (replaceBeforeDelivery) 0 else 1, deliveries)
        if (!replaceBeforeDelivery) assertTrue(onMain)
        set(manager, "socket", null)
    }

    @Test fun permissionsAreDeliveredOnMain() = checkDelivery(assistant = false, replaceBeforeDelivery = false)
    @Test fun assistantPacketsAreDeliveredOnMain() = checkDelivery(assistant = true, replaceBeforeDelivery = false)
    @Test fun queuedPermissionsFromAReplacedSocketAreDropped() = checkDelivery(assistant = false, replaceBeforeDelivery = true)
    @Test fun queuedAssistantPacketsFromAReplacedSocketAreDropped() = checkDelivery(assistant = true, replaceBeforeDelivery = true)
}
