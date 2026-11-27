package conclave.module

import io.socket.client.Ack
import io.socket.client.Socket
import io.socket.emitter.Emitter
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import skip.foundation.Data

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class WheelFormatSocketTests {
    private class Wire : Socket(null, "/", null) {
        var response = JSONObject()
        var request = JSONObject()

        override fun emit(event: String?, vararg args: Any?): Emitter {
            if (event == "apps:yjs:sync") {
                request = args.first() as JSONObject
                (args.last() as Ack).call(response)
            }
            return this
        }
    }

    @Test fun wheelRequiresFormatAgreementWithoutChangingOtherApps() {
        runBlocking {
            val manager = SocketIOManager()
            val wire = Wire()
            SocketIOManager::class.java.getDeclaredField("socket")
                .apply { isAccessible = true }
                .set(manager, wire)
            wire.response = JSONObject().put("syncMessage", "AA==")
            assertTrue(runCatching { manager.syncApp("wheel", Data()) }.isFailure)
            assertEquals(2, wire.request.getInt("wheelFormat"))

            wire.response.put("wheelFormat", 2)
            manager.syncApp("wheel", Data())
            assertEquals("wheel", wire.request.getString("appId"))

            wire.response.remove("wheelFormat")
            manager.syncApp("watch", Data())
            assertFalse(wire.request.has("wheelFormat"))
        }
    }
}
