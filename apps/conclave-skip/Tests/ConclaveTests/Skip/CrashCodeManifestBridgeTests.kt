package conclave.module

import java.nio.ByteBuffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The compiled-class manifest as the app reads it: sorted 64-bit pair hashes, in the format the build writes. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class CrashCodeManifestBridgeTests {
    private fun asset(vararg entries: String): ByteArray {
        val hashes = entries.map { CrashCodeManifest.hash(it) }.sorted()
        val buffer = ByteBuffer.allocate(hashes.size * 8)
        for (hash in hashes) buffer.putLong(hash)
        return buffer.array()
    }

    @Test
    fun theHashIsTheFirstEightBytesOfSha256ThatTheBuildWrites() {
        assertEquals(-402020156731862900L, CrashCodeManifest.hash("conclave.module.WebRTCClient\tWebRTCClient+Android.kt"))
    }

    @Test
    fun onlyAListedClassAndFilePairIsFound() {
        val table = CrashCodeManifest.table(asset(
            "conclave.module.WebRTCClient\tWebRTCClient+Android.kt",
            "conclave.module.WebRTCClient\$SendSessionListener\tWebRTCClient+Android.kt",
            "skip.ui.View\tView.kt",
        ))
        assertTrue(CrashCodeManifest.contains(table, "conclave.module.WebRTCClient\tWebRTCClient+Android.kt"))
        assertTrue(CrashCodeManifest.contains(table, "conclave.module.WebRTCClient\$SendSessionListener\tWebRTCClient+Android.kt"))
        for (entry in listOf("conclave.PrivateRoomCedar\tDeviceCedar.kt", "conclave.module.WebRTCClient\tDeviceCedar.kt",
            "conclave.module.WebRTCClient\t", "skip.ui.View\tview.kt")) {
            assertFalse(entry, CrashCodeManifest.contains(table, entry))
        }
        assertFalse(CrashCodeManifest.contains(LongArray(0), "conclave.module.WebRTCClient\tWebRTCClient+Android.kt"))
    }
}
