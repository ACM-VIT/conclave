package conclave.module

import io.socket.client.Ack
import io.socket.client.Socket
import io.socket.emitter.Emitter
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class RoomRecoveryPassSocketTests {
    private class Wire : Socket(null, "/", null) {
        var response = JSONObject()
        var request = JSONObject()

        override fun emit(event: String?, vararg args: Any?): Emitter {
            if (event == "joinRoom") {
                request = args.first() as JSONObject
                (args.last() as Ack).call(response)
            }
            return this
        }

        fun renew(roomId: String, pass: String) {
            val packet = JSONObject().put("roomId", roomId).put("roomRecoveryPass", pass)
            for (listener in listeners("roomRecoveryPass")) listener.call(packet)
        }
    }

    @Test fun joinWireCarriesThePassAndRenewalRequiresTheCurrentJoinedSocketAndRoom() {
        runBlocking {
            val manager = SocketIOManager()
            val socket = SocketIOManager::class.java.getDeclaredField("socket").apply { isAccessible = true }
            val handlers = SocketIOManager::class.java.getDeclaredMethod("registerEventHandlers", Socket::class.java)
                .apply { isAccessible = true }
            val wire = Wire()
            socket.set(manager, wire)
            handlers.invoke(manager, wire)
            val renewals = mutableListOf<String>()
            manager.onRoomRecoveryPass = { renewals.add(it.roomRecoveryPass) }

            val roomId = "abc-mnop-xyz"
            wire.response = JSONObject().put("status", "joined").put("roomId", roomId)
                .put("roomRecoveryPass", "signed.first.pass")
            wire.renew(roomId, "signed.before.join")
            val joined = manager.joinRoom(roomId = roomId, sessionId = "session", displayName = null)
            assertEquals("signed.first.pass", joined.roomRecoveryPass)
            assertFalse(wire.request.has("roomRecoveryPass"))

            wire.renew("different", "signed.wrong.room")
            wire.renew(roomId, "signed.renewed.pass")
            assertEquals(listOf("signed.renewed.pass"), renewals)
            manager.joinRoom(roomId = roomId, sessionId = "session", displayName = null,
                roomRecoveryPass = renewals.single())
            assertEquals("signed.renewed.pass", wire.request.getString("roomRecoveryPass"))

            val replacement = Wire()
            socket.set(manager, replacement)
            handlers.invoke(manager, replacement)
            wire.renew(roomId, "signed.stale.socket")
            replacement.response = JSONObject().put("status", "waiting").put("roomId", roomId)
            manager.joinRoom(roomId = roomId, sessionId = "session", displayName = null)
            replacement.renew(roomId, "signed.waiting.pass")
            assertEquals(listOf("signed.renewed.pass"), renewals)
            assertFalse(replacement.request.has("roomRecoveryPass"))
        }
    }
}
