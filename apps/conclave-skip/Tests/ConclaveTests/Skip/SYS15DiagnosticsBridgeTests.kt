package conclave.module

import android.content.Intent
import android.net.Uri
import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class SYS15DiagnosticsBridgeTests {
    private class Recording {
        var now = 1_000.0
        var wall = 1_761_661_353_000.0
        val begins = mutableListOf<String>()
        val ends = mutableListOf<String>()
        var installs = 0

        fun hooks(): DiagnosticsPlatformHooks {
            val hooks = DiagnosticsPlatformHooks()
            hooks.beginInterval = { name, _, _ -> begins.add(name) }
            hooks.endInterval = { name, _, _ -> ends.add(name) }
            hooks.installListeners = { _ -> installs += 1 }
            hooks.monotonicMillis = { now }
            hooks.wallMillis = { wall }
            hooks.info = { DiagnosticsPlatformInfo(platform = "android", appVersion = "2.0.0 (50)", osVersion = "Android 9 (API 28)", deviceClass = "phone") }
            return hooks
        }
    }

    private fun store(): DiagnosticsFileStore {
        val base = Files.createTempDirectory("sys15").toFile()
        return DiagnosticsFileStore(directoryPath = File(base, "store").path, exportDirectoryPath = File(base, "exports").path)
    }

    private fun snapshot(
        phase: CallPresencePhase,
        session: Int = 1,
        isInPip: Boolean = false,
        endReason: CallEndReason = CallEndReason.none,
    ): CallPresenceSnapshot = CallPresenceSnapshot(
        revision = 1, presenceSession = session, callSession = session, phase = phase, title = "lily-zoro-iris",
        roomId = "lily-zoro-iris", joinedAtMillis = 1_000.0, isMuted = true, isCameraOn = false, isPresenting = false,
        isAttendee = false, surface = CallSystemSurfaceKind.none, surfaceStatus = CallSurfaceStatus.inactive,
        interruption = AudioInterruptionKind.none, pip = PipAvailability.eligible, isInPictureInPicture = isInPip,
        pipTarget = null, keepsScreenAwake = true, proximityArmed = false, cameraContinuesInBackground = false,
        endReason = endReason,
    )

    private fun crumb(code: String) = DiagnosticsBreadcrumb(code = code, phase = "live", kind = "event", atMillis = 1.0,
        attempt = 1, durationMillis = -1.0, detail = "")

    @Test
    fun theRingKeepsTheNewest200AndRedactionIsStructural() {
        val ring = DiagnosticsBreadcrumbRing(capacity = DiagnosticsLimits.breadcrumbCapacity)
        for (index in 0 until 250) ring.append(crumb("test.event$index"))
        val items = ring.snapshot().toList()
        assertEquals(200, ring.count)
        assertEquals("test.event50", items.first().code)
        assertEquals("test.event249", items.last().code)
        assertEquals(50, ring.droppedCount)

        assertTrue(DiagnosticsRedactionPolicy.isAllowedCode("socket.timeout"))
        assertTrue(DiagnosticsRedactionPolicy.isAllowedCode("call.end.userLeft"))
        assertFalse(DiagnosticsRedactionPolicy.isAllowedCode("lily-zoro-iris"))
        assertFalse(DiagnosticsRedactionPolicy.isAllowedCode("message.lily-zoro-iris"))
        assertFalse(DiagnosticsRedactionPolicy.isAllowedCode("message.Hello there"))
        assertFalse(DiagnosticsRedactionPolicy.isAllowedCode("chat.hello"))
        assertEquals("other", DiagnosticsRedactionPolicy.sanitizedPhase("Zelda"))
        assertEquals("live", DiagnosticsRedactionPolicy.sanitizedPhase("live"))
        assertTrue(DiagnosticsRedactionPolicy.isAllowedFieldText("Android 9 (API 28)"))
        assertFalse(DiagnosticsRedactionPolicy.isAllowedFieldText("Zelda's room?"))
    }

    @Test
    fun retentionAndUtcStampsMatchTheSwiftSuite() {
        val day = 24.0 * 60.0 * 60.0 * 1000.0
        val now = 100.0 * day
        val records = skip.lib.Array(listOf(
            DiagnosticsStoredRecord(name = "a", createdAtMillis = now - 8 * day, byteCount = 10),
            DiagnosticsStoredRecord(name = "b", createdAtMillis = now - 3 * day, byteCount = 900_000),
            DiagnosticsStoredRecord(name = "c", createdAtMillis = now - 2 * day, byteCount = 900_000),
            DiagnosticsStoredRecord(name = "d", createdAtMillis = now - 1 * day, byteCount = 900_000),
        ))
        assertEquals(listOf("a", "b"), DiagnosticsRetentionPolicy.namesToDelete(records, nowMillis = now).toList())
        assertEquals("2025-10-28T14:22:33Z", DiagnosticsTimePolicy.iso8601(epochMillis = 1_761_661_353_000.0))
        assertEquals("2024-02-29T12:00:00Z", DiagnosticsTimePolicy.iso8601(epochMillis = 1_709_208_000_000.0))
        assertEquals("20251028-142233", DiagnosticsTimePolicy.fileStamp(epochMillis = 1_761_661_353_000.0))
        assertEquals("12", DiagnosticsJSON.number(12.0))
        assertEquals("0", DiagnosticsJSON.number(Double.NaN))
    }

    @Test
    fun twentyPresenceCyclesKeepOneListenerSetBalancedSpansAndABoundedBuffer() {
        val recording = Recording()
        val diagnostics = CallDiagnostics(store = store(), hooks = recording.hooks())
        diagnostics.install()
        diagnostics.install()
        val adapter = diagnostics.makePresenceAdapter()
        var old = snapshot(CallPresencePhase.idle, session = 0)
        for (cycle in 1..20) {
            val steps = listOf(
                snapshot(CallPresencePhase.connecting, session = cycle),
                snapshot(CallPresencePhase.live, session = cycle),
                snapshot(CallPresencePhase.live, session = cycle, isInPip = true),
                snapshot(CallPresencePhase.recovering, session = cycle, isInPip = true),
                snapshot(CallPresencePhase.live, session = cycle),
                snapshot(CallPresencePhase.ending, session = cycle),
                snapshot(CallPresencePhase.idle, session = 0, endReason = CallEndReason.userLeft),
            )
            for (next in steps) {
                adapter.presenceDidChange(old, next)
                old = next
            }
            recording.now += 100.0
        }
        assertEquals(1, diagnostics.listenerCount)
        assertEquals(1, recording.installs)
        assertEquals("1", diagnostics.readoutValue(DiagnosticsReadout.listenersKey))
        assertTrue(diagnostics.bufferCount <= DiagnosticsLimits.breadcrumbCapacity)
        assertEquals(0, diagnostics.openSpanCount)
        assertEquals(diagnostics.spanBeginCount, diagnostics.spanEndCount)
        assertEquals(recording.begins.size, recording.ends.size)
        assertTrue(recording.begins.containsAll(listOf("join", "pip", "recovery", "cleanup")))
    }

    @Test
    fun spansEndOnceAndUnknownNamesAreInert() {
        val recording = Recording()
        val diagnostics = CallDiagnostics(store = store(), hooks = recording.hooks())
        val mute = diagnostics.span(DiagnosticsSpanKind.mute.rawValue, callSession = 4)
        recording.now += 180.0
        assertEquals(180.0, diagnostics.end(mute), 0.0)
        assertEquals(-1.0, diagnostics.end(mute), 0.0)
        assertTrue(diagnostics.span("Zelda", callSession = 4).isInert)
        diagnostics.record(code = "Zelda joined lily-zoro-iris")
        assertEquals(DiagnosticsRedactionPolicy.rejectedCode, diagnostics.events.toList().last().code)
    }

    @Test
    fun theExportCarriesMetadataAndNoMarkerStrings() {
        val store = store()
        val recording = Recording()

        recording.wall = System.currentTimeMillis().toDouble()
        val diagnostics = CallDiagnostics(store = store, hooks = recording.hooks())
        diagnostics.sensitiveValues = { skip.lib.Array(listOf("Zelda Quartermaine", "lily-zoro-iris")) }
        diagnostics.record(code = "lily-zoro-iris")
        diagnostics.record(code = "message.Zelda Quartermaine")
        diagnostics.record(code = "socket.timeout")
        val leaky = DiagnosticsPayloadFactory.payload(kind = DiagnosticsPayloadKind.exitReason,
            createdAtMillis = recording.wall - 1_000.0, fields = skip.lib.Array(listOf(DiagnosticsPayloadFactory.number("status", 0.0))),
            detailJSON = NativePerformanceDiagnostics.traceJSON("\"Zelda Quartermaine\" prio=5 tid=9 Native\n  at a.b.C.d(C.kt:1)"))
        assertTrue(store.writePayload(leaky))
        val outcome = store.export(diagnostics.makeExportInput())
        assertEquals(DiagnosticsExportFailure.none, outcome.failure)
        val text = File(outcome.path).readText()
        val json = JSONObject(text)
        assertEquals("conclave-diagnostics", json.getString("format"))
        assertEquals("android", json.getJSONObject("metadata").getString("platform"))
        assertFalse(json.getJSONObject("metadata").getBoolean("remoteUpload"))
        assertFalse(text.lowercase().contains("zelda"))
        assertFalse(text.contains("lily-zoro-iris"))
        assertTrue(text.contains("socket.timeout"))

        assertEquals(1, json.getJSONArray("payloads").length())
        assertEquals(1, json.getJSONObject("counters").getInt("diag.withheldPayloads"))
        assertTrue(File(outcome.path).name.startsWith(DiagnosticsFileStore.exportPrefix))

        diagnostics.debugForcesRedactionFailure = true
        val refused = store.export(diagnostics.makeExportInput())

        if (DiagnosticsBuild.isDebug) {
            assertEquals(DiagnosticsExportFailure.redactionCheckFailed, refused.failure)
            assertEquals("", refused.path)
        }
    }

    @Test
    fun anrTracesKeepOnlyFramesAndPlainThreadNames() {
        val trace = """
            ----- pid 1234 at 2026-10-28 10:00:00 -----
            Cmd line: com.acmvit.conclave
            "main" prio=5 tid=1 Blocked
              | state=S schedstat=( 0 0 0 ) utm=1 stm=0 core=0 HZ=100
              at conclave.module.MeetingViewModel.toggleMute(MeetingViewModel.kt:42)
              - waiting to lock <0x0a1b2c3d> (a java.lang.Object) held by thread 12
              native: #00 pc 000000000004a8a4  /apex/com.android.runtime/lib64/bionic/libc.so (syscall+36)
            "OkHttp https://conclave.acmvit.in/api/rooms/lily-zoro-iris" daemon prio=5 tid=12 Waiting
              at java.lang.Object.wait(Native method)
            Chat said: Zelda Quartermaine is here
        """.trimIndent()
        val lines = NativePerformanceDiagnostics.sanitizedTraceLines(trace)
        assertEquals("\"main\" prio=5 tid=1 Blocked", lines[0])
        assertTrue(lines.any { it.startsWith("at conclave.module.MeetingViewModel.toggleMute") })
        assertTrue(lines.any { it.startsWith("native: #00") })
        assertTrue(lines.any { it.startsWith("\"thread-2\" daemon prio=5 tid=12") })
        val joined = lines.joinToString("\n")
        assertFalse(joined.contains("lily-zoro-iris"))
        assertFalse(joined.contains("Zelda"))
        assertFalse(joined.contains("Cmd line"))
        val json = JSONObject(NativePerformanceDiagnostics.traceJSON(trace))
        assertEquals(lines.size, json.getJSONArray("traceLines").length())
        assertEquals("", NativePerformanceDiagnostics.traceJSON("nothing to keep here"))
    }

    @Test
    fun processStateSummaryRoundTripsAndExitReasonsHaveNames() {
        val bytes = NativePerformanceDiagnostics.processStateSummary(7, "recovering")
        assertEquals("s=7;p=recovering", String(bytes, Charsets.UTF_8))
        assertEquals(Pair(7, "recovering"), NativePerformanceDiagnostics.parseProcessStateSummary(bytes))
        assertEquals(Pair(0, ""), NativePerformanceDiagnostics.parseProcessStateSummary(null))
        assertTrue(NativePerformanceDiagnostics.processStateSummary(1, "x".repeat(300)).size <= 128)
        assertEquals("anr", NativePerformanceDiagnostics.exitReasonName(6))
        assertEquals("crashNative", NativePerformanceDiagnostics.exitReasonName(5))
        assertEquals("reason99", NativePerformanceDiagnostics.exitReasonName(99))
        val record = DiagnosticsPayloadFactory.exitRecord(reason = "anr", timestampMillis = 1_000.0, importance = 100, status = 0,
            pssKb = 1.0, rssKb = 2.0, summarySession = 7, summaryPhase = "recovering", traceJSON = "")
        assertTrue(DiagnosticsRedactionPolicy.isClean(record))
        assertEquals("conclave.join", NativePerformanceDiagnostics.traceSectionName("join"))
    }

    @Test
    fun theShareIntentSendsOneJsonFileWithAReadGrant() {
        val uri = Uri.parse("content://com.acmvit.conclave.fileprovider/exports/diagnostics/conclave-diagnostics-20251028-142233.json")
        val intent = NativePerformanceDiagnostics.buildDiagnosticsSendIntent(uri, "Conclave diagnostics")
        assertEquals(Intent.ACTION_SEND, intent.action)
        assertEquals("application/json", intent.type)
        @Suppress("DEPRECATION")
        assertEquals(uri, intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        assertEquals("Conclave diagnostics", intent.getStringExtra(Intent.EXTRA_SUBJECT))
        assertEquals("Conclave diagnostics", intent.getStringExtra(Intent.EXTRA_TITLE))
        assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        assertEquals(uri, intent.clipData?.getItemAt(0)?.uri)
    }
}
