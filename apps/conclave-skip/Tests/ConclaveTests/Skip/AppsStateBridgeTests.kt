package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import skip.foundation.Data
import skip.foundation.JSONDecoder

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class AppsStateBridgeTests {
    @Test fun decodesTheAppsStateANewerSfuSends() {
        val json = "{\"roomId\":\"room-a\",\"activeAppId\":\"wheel\",\"locked\":false," +
            "\"revision\":7,\"savedAppIds\":[\"watch\",\"whiteboard\"],\"docGeneration\":3}"

        val state = decode(json)

        assertEquals("room-a", state.roomId)
        assertEquals("wheel", state.activeAppId)
        assertFalse(state.locked)
        assertEquals(7, state.revision)
        assertEquals(3, state.docGeneration)
    }

    @Test fun decodesNoRevisionOrDocumentFromAnOlderSfu() {
        val state = decode("{\"roomId\":\"room-a\",\"activeAppId\":\"whiteboard\",\"locked\":false}")

        assertNull(state.revision)
        assertNull(state.docGeneration)
    }

    private fun decode(json: String): AppsStateNotification =
        JSONDecoder().decode(AppsStateNotification::class, from = Data(platformValue = json.toByteArray(Charsets.UTF_8)))
}
