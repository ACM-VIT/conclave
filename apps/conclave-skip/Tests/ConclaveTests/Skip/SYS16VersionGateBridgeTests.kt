package conclave.module

import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class SYS16VersionGateBridgeTests {
    @Test fun theTranspiledPolicyComparesDottedVersionsNumerically() {
        assertEquals("android", VersionGatePolicy.platform)
        assertTrue(VersionGatePolicy.requiresUpdate("1.2.0", "1.10.0"))
        assertTrue(VersionGatePolicy.requiresUpdate("1.0.11", "2.0.0"))
        assertFalse(VersionGatePolicy.requiresUpdate("2.0.0", "2.0.0"))
        assertFalse(VersionGatePolicy.requiresUpdate("2.0", "2.0.0"))
        for (value in listOf("", "v2", "2.0.0-beta", "1..2", "1.2.3.4.5", "99999", "+2")) {
            assertNull(value, VersionGatePolicy.components(value))
            assertFalse(VersionGatePolicy.requiresUpdate("1.0.0", value))
        }
        assertEquals(listOf(2, 10, 3), VersionGatePolicy.components(" 2.10.3 ")!!.toList())
    }

    @Test fun aMalformedFieldOpensTheGateAndOfflineUsesTheCachedFloor() {
        val malformed = VersionGatePolicy.resolve(
            VersionGateFetch.payload(MinNativeVersionPayload(ios = "2.0.0", android = "latest")), "android", "1.0.0", "9.0.0",
        )
        assertFalse(malformed.state.updateRequired)
        assertEquals(VersionGateCacheChange.clear, malformed.cache)
        assertTrue(malformed.invalidField)

        val equal = VersionGatePolicy.resolve(
            VersionGateFetch.payload(MinNativeVersionPayload(ios = "9.0.0", android = "2.0.0")), "android", "2.0.0", null,
        )
        assertFalse(equal.state.updateRequired)
        assertEquals(VersionGateCacheChange.store("2.0.0"), equal.cache)

        val offline = VersionGatePolicy.resolve(VersionGateFetch.unavailable, "android", "1.9.9", "2.0.0")
        assertTrue(offline.state.updateRequired)
        assertEquals("2.0.0", offline.state.minimum)
        assertEquals(VersionGateCacheChange.keep, offline.cache)
        assertFalse(offline.invalidField)
    }

    @Test fun theTranspiledDecoderIsLenient() {
        assertEquals(
            VersionGateFetch.payload(MinNativeVersionPayload(ios = null, android = "2.0.1")),
            VersionGateService.decode(200, """{"minNativeVersion":{"ios":2,"android":"2.0.1"}}"""),
        )
        assertEquals(
            VersionGateFetch.payload(MinNativeVersionPayload(ios = null, android = null)),
            VersionGateService.decode(200, """{"minNativeVersion":{"ios":2,"android":3}}"""),
        )
        for (field in listOf("true", "{\"major\":9}", "[9]")) {
            val fetch = VersionGateService.decode(200, """{"minNativeVersion":{"android":$field}}""")
            val resolution = VersionGatePolicy.resolve(fetch, "android", "1.0.0", null)
            assertFalse(field, resolution.state.updateRequired)
            assertTrue(field, resolution.invalidField)
        }
        assertEquals(VersionGateFetch.payload(null), VersionGateService.decode(200, """{"minNativeVersion":"2.0.0"}"""))
        assertEquals(VersionGateFetch.unavailable, VersionGateService.decode(200, "<html></html>"))
        assertEquals(VersionGateFetch.unavailable, VersionGateService.decode(503, """{"minNativeVersion":{"android":"9.0.0"}}"""))
    }

    @Test fun theJoinResponseReadsTheFieldStrictly() {
        fun data(json: String) = skip.foundation.Data(platformValue = json.toByteArray())
        val good = SfuJoinInfo.decode(data("""{"token":"t","sfuUrl":"wss://s","minNativeVersion":{"ios":"2.0.0","android":"2.0.1"}}"""))
        assertEquals("t", good.token)
        assertEquals("2.0.1", good.minNativeVersion?.android)
        for (field in listOf("[\"9\"]", "[9]", "9", "true")) {
            val malformed = SfuJoinInfo.decode(data("""{"token":"t","sfuUrl":"wss://s","minNativeVersion":{"android":$field}}"""))
            assertEquals(field, "t", malformed.token)
            assertNull(field, malformed.minNativeVersion?.android)
        }
    }

    @Test fun theStoreListingOpensThePlayListingAsAViewIntent() {
        assertEquals("https://play.google.com/store/apps/details?id=com.acmvit.conclave", StoreListing.platformURL)
        val context = RuntimeEnvironment.getApplication()
        assertTrue(NativeAppInfo.openStoreListing(context, StoreListing.platformURL))
        val started = shadowOf(context).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, started.action)
        assertEquals(Uri.parse(StoreListing.playStoreURL), started.data)
        assertTrue(started.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
    }
}
