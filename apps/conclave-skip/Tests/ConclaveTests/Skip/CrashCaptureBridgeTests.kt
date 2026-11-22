package conclave.module

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class CrashCaptureBridgeTests {
    @Test
    fun anUncaughtAndroidCrashBecomesAPostHogExceptionWithItsCauses() {
        val compiledClass = CrashCaptureBridgeTests::class.java.name + "\tCrashCaptureBridgeTests.kt"
        val previous = CrashReportPrivacy.isCompiledAppClass
        CrashReportPrivacy.isCompiledAppClass = { entry -> entry == compiledClass }
        try {
            assertUncaughtCrashUploads()
        } finally {
            CrashReportPrivacy.isCompiledAppClass = previous
        }
    }

    private fun assertUncaughtCrashUploads() {
        val crash = IllegalStateException("user text that must not leave", RuntimeException("cause text"))
        val payload = AndroidCrashCapture.payload(crash, listOf("join.socketConnected", "bad code"), "live", 1_795_000_000_000.0)
        assertEquals(DiagnosticsPayloadKind.crash.rawValue, payload.kind)
        val context = CrashReportContext(installId = "install-1", platform = "android", appVersion = "2.0.0 (64)",
            osVersion = "Android 16 (API 36)", deviceClass = "phone")
        val text = CrashReportEventBuilder.event(payload, eventId = "id-1", context = context)
        assertNotNull(text)
        assertFalse(text!!.contains("user text") || text.contains("cause text"))
        val properties = JSONObject(text).getJSONObject("properties")
        assertEquals("fatal", properties.getString("\$exception_level"))
        assertEquals("live", properties.getString("call_phase"))
        assertEquals(listOf("join.socketConnected"),
            (0 until properties.getJSONArray("breadcrumbs").length()).map { properties.getJSONArray("breadcrumbs").getString(it) })
        val exceptions = properties.getJSONArray("\$exception_list")
        assertEquals(2, exceptions.length())
        assertEquals("java.lang.IllegalStateException", exceptions.getJSONObject(0).getString("type"))
        assertEquals("java.lang.RuntimeException", exceptions.getJSONObject(1).getString("type"))
        val frames = exceptions.getJSONObject(0).getJSONObject("stacktrace").getJSONArray("frames")
        val innermost = frames.getJSONObject(frames.length() - 1)
        assertEquals("assertUncaughtCrashUploads", innermost.getString("function"))
        assertEquals(CrashCaptureBridgeTests::class.java.name, innermost.getString("module"))
        assertTrue(innermost.getInt("lineno") > 0)
    }
}
