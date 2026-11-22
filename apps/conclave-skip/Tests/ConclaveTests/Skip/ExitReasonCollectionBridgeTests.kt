package conclave.module

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowActivityManager
import skip.foundation.AssetURLProtocol

/** Android exit records collected on the next launch, from ApplicationExitInfo to the uploaded event. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class ExitReasonCollectionBridgeTests {
    /**
     * Skip's Bundle installs its asset URL handler JVM-wide, which Java allows once. The rest of the suite owns it from
     * the SDK 28 sandbox; registering again from this SDK 33 sandbox (JSON encoding loads Bundle) throws and fails
     * whichever class runs second.
     */
    @Before
    fun leaveTheAssetUrlHandlerToTheSharedSandbox() {
        AssetURLProtocol::class.java.getDeclaredField("registered").apply { isAccessible = true }.setBoolean(null, true)
    }

    private class Proto {
        val out = ByteArrayOutputStream()
        fun varint(value: Long) {
            var rest = value
            while (rest and 0x7FL.inv() != 0L) {
                out.write(((rest and 0x7F) or 0x80).toInt())
                rest = rest ushr 7
            }
            out.write(rest.toInt())
        }
        fun tag(field: Int, wire: Int) = varint(((field shl 3) or wire).toLong())
        fun uint(field: Int, value: Long) { tag(field, 0); varint(value) }
        fun bytes(field: Int, value: ByteArray) { tag(field, 2); varint(value.size.toLong()); out.write(value) }
        fun string(field: Int, value: String) = bytes(field, value.toByteArray(Charsets.UTF_8))
        fun message(field: Int, build: Proto.() -> Unit) = bytes(field, Proto().apply(build).out.toByteArray())
    }

    private fun Proto.thread(id: Long, name: String, frames: List<Triple<String, String, Long>>) = message(16) {
        uint(1, id)
        message(2) {
            uint(1, id)
            string(2, name)
            for ((function, file, relPc) in frames) {
                message(4) {
                    uint(1, relPc)
                    string(4, function)
                    uint(5, 8)
                    string(6, file)
                }
            }
        }
    }

    private fun nativeCrashTombstone(): ByteArray = Proto().apply {
        uint(6, 42)
        message(10) {
            uint(1, 11)
            string(2, "SIGSEGV")
        }
        string(14, "Abort message from Jane Doe's session")
        thread(7, "RenderThread", listOf(Triple("android::uirenderer::RenderThread::threadLoop", "/system/lib64/libhwui.so", 0x10)))
        thread(42, "ConclaveSendTra", listOf(
            Triple("mediasoupclient::SendTransport::Produce", "/data/app/~~abc==/com.acmvit.conclave-def==/lib/arm64/libmediasoupclient_so.so", 0x1234),
            Triple("__start_thread", "/apex/com.android.runtime/lib64/bionic/libc.so", 0x99),
            Triple("", "/storage/emulated/0/Jane.so Smith/libnotes.so", 0x77),
        ))
    }.out.toByteArray()

    private fun collect(info: ApplicationExitInfo): DiagnosticsStoredPayload {
        val context = RuntimeEnvironment.getApplication()
        shadowOf(context.getSystemService(ActivityManager::class.java)).addApplicationExitInfo(info)
        val directory = Files.createTempDirectory("exit-reasons").toFile()
        val store = DiagnosticsFileStore(directoryPath = directory.resolve("store").path,
            exportDirectoryPath = directory.resolve("exports").path)
        NativePerformanceDiagnostics::class.java
            .getDeclaredMethod("collectExitReasons", Context::class.java, DiagnosticsFileStore::class.java)
            .apply { isAccessible = true }
            .invoke(NativePerformanceDiagnostics, context, store)
        val payloads = store.loadPayloads().toList()
        assertEquals(1, payloads.size)
        return payloads[0].payload
    }

    private fun upload(payload: DiagnosticsStoredPayload): JSONObject {
        val uploader = CrashReportContext(installId = "install-1", platform = "android", appVersion = "9.9.9 (999)",
            osVersion = "Android 16 (API 36)", deviceClass = "phone")
        val text = CrashReportEventBuilder.event(payload, eventId = "id-1", context = uploader)
        assertNotNull(text)
        return JSONObject(text!!)
    }

    @Test
    fun aNativeCrashTombstoneUploadsTheCrashedThreadsFramesAndNothingElse() {
        val info = ShadowActivityManager.ApplicationExitInfoBuilder.newBuilder()
            .setReason(ApplicationExitInfo.REASON_CRASH_NATIVE)
            .setTimestamp(1_795_000_000_000)
            .setImportance(100)
            .setTraceInputStream(ByteArrayInputStream(nativeCrashTombstone()))
            .setProcessStateSummary(NativePerformanceDiagnostics.processStateSummary(3, "live", "2.0.0 (63)"))
            .build()

        val event = upload(collect(info))
        val text = event.toString()

        assertEquals("\$exception", event.getString("event"))
        val properties = event.getJSONObject("properties")
        assertEquals("live", properties.getString("call_phase"))
        val exception = properties.getJSONArray("\$exception_list").getJSONObject(0)
        assertEquals("SIGSEGV", exception.getString("type"))
        val frames = exception.getJSONObject("stacktrace").getJSONArray("frames")
        assertEquals(3, frames.length())
        val crashSite = frames.getJSONObject(frames.length() - 1)
        assertEquals("mediasoupclient::SendTransport::Produce", crashSite.getString("function"))
        assertEquals("libmediasoupclient_so.so", crashSite.getString("filename"))
        assertTrue(crashSite.getBoolean("in_app"))
        val unknownLibrary = frames.getJSONObject(0)
        assertFalse(unknownLibrary.getBoolean("in_app"))
        assertEquals("[path]+0x77", unknownLibrary.getString("function"))
        assertEquals("[path]", unknownLibrary.getString("module"))
        assertEquals("libc.so", frames.getJSONObject(1).getString("module"))
        assertFalse(text.contains("Smith") || text.contains("libnotes") || text.contains("/storage"))
        assertFalse(text.contains("RenderThread") || text.contains("threadLoop"))
        assertFalse(text.contains("Jane") || text.contains("/data/app") || text.contains("com.acmvit.conclave-def"))
    }

    @Test
    fun anExitRecordNamesTheReleaseThatWasRunningNotTheOneUploading() {
        val info = ShadowActivityManager.ApplicationExitInfoBuilder.newBuilder()
            .setReason(ApplicationExitInfo.REASON_ANR)
            .setTimestamp(1_795_000_000_000)
            .setImportance(100)
            .setProcessStateSummary(NativePerformanceDiagnostics.processStateSummary(2, "connecting", "2.0.0 (63)"))
            .build()

        val properties = upload(collect(info)).getJSONObject("properties")

        assertEquals("2.0.0 (63)", properties.getString("\$app_version"))
        assertEquals("connecting", properties.getString("call_phase"))
    }

    @Test
    fun anUncaughtCrashNamesTheReleaseItCrashedIn() {
        val payload = AndroidCrashCapture.payload(IllegalStateException("boom"), emptyList(), "live", 1_795_000_000_000.0,
            "2.0.0 (63)")

        assertEquals("2.0.0 (63)", upload(payload).getJSONObject("properties").getString("\$app_version"))
    }
}
