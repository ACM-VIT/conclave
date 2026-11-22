package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
            "\"revision\":7,\"savedAppIds\":[\"watch\",\"whiteboard\"]}"

        val state = JSONDecoder().decode(AppsStateNotification::class, from = Data(platformValue = json.toByteArray(Charsets.UTF_8)))

        assertEquals("room-a", state.roomId)
        assertEquals("wheel", state.activeAppId)
        assertFalse(state.locked)
    }
}
