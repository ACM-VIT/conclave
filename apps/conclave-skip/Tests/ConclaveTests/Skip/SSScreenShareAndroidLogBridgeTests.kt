package conclave.module

import android.util.Log
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class SSScreenShareAndroidLogBridgeTests {
    private fun shareLines(): List<ShadowLog.LogItem> =
        ShadowLog.getLogsForTag(ScreenShareAndroidLog.TAG).orEmpty()

    @Test
    fun aBranchWithoutAnErrorLogsTheBranchAtWarn() {
        ShadowLog.clear()
        ScreenShareAndroidLog.warn("noActivity", null)
        val lines = shareLines()
        assertEquals(1, lines.size)
        assertEquals(Log.WARN, lines[0].type)
        assertEquals("noActivity", lines[0].msg)
    }

    @Test
    fun anErrorLogsItsClassNameButNeverItsMessage() {
        ShadowLog.clear()
        ScreenShareAndroidLog.warn("launchThrew", IllegalStateException("secret text"))
        val lines = shareLines()
        assertEquals(1, lines.size)
        assertEquals("launchThrew java.lang.IllegalStateException", lines[0].msg)
        assertFalse(lines[0].msg.contains("secret text"))
    }
}
